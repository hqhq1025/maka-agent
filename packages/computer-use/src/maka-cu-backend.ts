// The `maka.cu/2` CuDispatchBackend. Speaks the host protocol (`maka-cu`'s
// docs/HOST_PROTOCOL.md) to `maka-cu`, the native macOS executor; section
// numbers in comments refer to that document.
//
// The point of this backend, next to the cua-driver one, is that frame binding
// lives in the executor. A dispatch quotes a snapshot id, an element token and
// the digest the host was given, and the executor answers `snapshot_spent`,
// `element_changed`, `element_released` or `process_replaced` instead of
// re-resolving an index against whatever the tree looks like now. So this file
// has no re-match pass, no occlusion geometry and no path guessing: it carries
// identity down and maps declared answers back.
//
// It is OFF by default (see select-backend.ts). The executor it talks to does
// not exist as a signed artifact yet, so nothing may fall back to it silently.
//
// What the protocol declares and Maka's own types cannot yet carry: per-element
// `truncated`, `snapshot.truncated`, `actions`, `subrole`, `placeholder`,
// `selectedText` and `obscuringRects`. They are read and validated here — a
// missing declared field is version skew the host must catch — but only the
// truncation flags reach anywhere, through `onTrace`. Giving them a model-facing
// home means new fields on `CuObservedElement`/`CuObservation`, which this
// change deliberately does not make.
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ComputerUseDisplayIdentity,
  ComputerUseErrorCode,
  ComputerUseRect,
  CuAction,
} from '@maka/core';
import type {
  CuAppSummary,
  CuDispatchBackend,
  CuDispatchOutcome,
  CuObservation,
  CuObservedElement,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
} from '@maka/runtime';
import { exceedsFrameCap, FRAME_COMPRESS_THRESHOLD_BYTES } from './frame-budget.js';
import {
  MAKA_CU_ALLOW_GLOBAL_POINTER,
  hostDigest,
  mapMakaCuDomainError,
  MakaCuProtocolViolation,
  parseMakaCuKeyChord,
  readApp,
  readDispatchResult,
  readImageField,
  readSnapshot,
  readWindow,
  MAKA_CU_RPC_ERROR,
  type MakaCuDispatchResult,
  type MakaCuDomainError,
  type MakaCuElement,
  type MakaCuEnvelope,
  type MakaCuImage,
  type MakaCuSnapshot,
  type MakaCuWindow,
} from './maka-cu-protocol.js';
import {
  isMakaCuLifecycleError,
  MakaCuRpcError,
  MakaCuService,
  type MakaCuReleaseEvent,
  type MakaCuServiceSnapshot,
} from './maka-cu-service.js';

/**
 * `CuAction.scrollAmount` has no declared unit at the tool boundary ("Amount for
 * scroll", 0..100) while `maka.cu/2` declares pages. The conversion is fixed
 * here, in one place, so the two ends cannot disagree silently. The number is a
 * convention, not a measurement — replace it with one when a real machine says
 * what a model-issued scroll of `n` should move.
 */
const SCROLL_UNITS_PER_PAGE = 10;

/** §6.1 secondary actions are a closed set of normalised names (§5 `actions`). */
const ELEMENT_ACTION_NAMES = [
  'press',
  'confirm',
  'open',
  'show_menu',
  'raise',
  'cancel',
  'pick',
  'increment',
  'decrement',
  'scroll_up',
  'scroll_down',
  'scroll_left',
  'scroll_right',
] as const;

export interface MakaCuBackendOptions {
  /** Absolute path to the `maka-cu` executable. */
  binaryPath: string;
  /**
   * Directory the executor writes every image into. Host-owned: purged before
   * every spawn and removed on dispose (§8). Defaults to a per-process temp dir.
   */
  imageDir?: string;
  /** Reported in `host.hello`; the executor logs it against its own version. */
  hostVersion?: string;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
  /** Pinned executable hash, verified before every spawn. */
  expectedBinarySha256?: string;
  /** Test seam: the protocol string sent in `host.hello`. */
  protocolVersion?: string;
  /**
   * Optional frame compressor: given a captured frame returns a smaller
   * encoding at the SAME resolution, so coordinates are unchanged. Applied only
   * to large frames; omitted under node --test, where frames pass through.
   */
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  /**
   * Host-owned physical-input guard. Returning true fences the pending input
   * before the executor receives any dispatch. Same option, same points as the
   * cua-driver backend.
   */
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  /**
   * Coordinate and key dispatch post synthetic events, which can interfere with
   * the user's physical input. Keep it disabled unless a host policy says
   * otherwise — the model-facing tool contract already states these fail closed.
   */
  allowCompatibilityInputDispatch?: boolean;
  /** Privacy-safe diagnostics: geometry, enums and counts only, never app text. */
  onTrace?: (event: MakaCuTraceEvent) => void;
  onSessionInvalidated?: (input: {
    sessionId: string;
    reason: MakaCuReleaseEvent['reason'];
    outcomeUnknown: boolean;
  }) => void;
}

export type MakaCuTraceEvent =
  | {
      type: 'observe';
      toolCallId?: string;
      snapshotId: string;
      pid: number;
      windowId: number;
      elementCount: number;
      /**
       * §7.4 bounds. Neither `CuObservation` nor `CuObservedElement` has a field
       * for them, so this trace is the only channel that reports a tree that was
       * cut. Silence here would mean a bounded observation looking complete.
       */
      truncatedElements: boolean;
      truncatedDepth: boolean;
      truncatedTextElements: number;
    }
  | {
      type: 'dispatch';
      toolCallId?: string;
      method: string;
      outcome: string;
      tier: string;
      path: string;
      effect: string;
      verificationMethod: string;
      settleMs?: number;
    }
  | {
      type: 'refusal';
      toolCallId?: string;
      method: string;
      code: string;
      /**
       * §1.1: a dispatch refusal carries the four declared fields, and §6.2
       * wants the code recorded — a repeated `element_digest_mismatch` is a bug
       * in this host while a repeated `element_changed` is a busy screen, and
       * nothing else in the exchange says which arrived.
       */
      outcome?: string;
      tier?: string;
      path?: string;
      effect?: string;
    }
  | {
      type: 'protocol_violation';
      toolCallId?: string;
      method: string;
      reason: string;
    };

interface StoredSnapshot {
  sessionId: string;
  turnId: string;
  snapshotId: string;
  pid: number;
  windowId: number;
  windowDigest: string;
  capturedAt: number;
  /** token → digest, echoed on every element dispatch (§4.3). */
  digests: Map<string, string>;
  /**
   * The id the model sees → the wire token.
   *
   * The token is 53 characters and every one in a snapshot shares a 45-character
   * prefix, because it embeds the snapshot id. Handed to a model as the thing to
   * quote back, it produced a turn that failed four times with
   * "Computer Use arguments failed validation" and the model's own explanation:
   * "看起来我漏掉了 element_id 参数". It had not missed it — it could not copy it.
   *
   * The wire is unchanged: dispatch still sends the full token, so the binding
   * the protocol exists for is exactly as strong. Only the model-facing name is
   * short, and this map is what makes that safe.
   */
  modelIds: Map<string, string>;
  focused?: { token: string; digest: string };
}

type CaptureFailure = CuRunResult & { outcome: Extract<CuRunResult['outcome'], { ok: false }> };

function failure(error: ComputerUseErrorCode, message: string): CaptureFailure {
  return { outcome: { ok: false, error, message } };
}

/** The host cleared the session while this operation was still queued. */
class MakaCuSessionCleared extends Error {
  constructor() {
    super('session was cleared before request delivery');
    this.name = 'MakaCuSessionCleared';
  }
}

/**
 * A domain refusal (§1.1) raised from a helper that cannot return a
 * `CuRunResult` — `session.begin`, `window.list`, `apps.list`. It carries the
 * envelope's error so the one mapping table (§7.1) still decides what the model
 * is told; throwing a plain Error here is what let a refused `session.begin`
 * escape `run`/`runSemantic` as an unmapped exception.
 */
class MakaCuDomainRefusal extends Error {
  constructor(
    readonly method: string,
    readonly domain: MakaCuDomainError,
  ) {
    super(`maka-cu ${method} refused: ${domain.code}`);
    this.name = 'MakaCuDomainRefusal';
  }
}

/**
 * A refusal the host decided by itself — the caller named a window that is not
 * open, or an {app, windowId} pair no window satisfies (§5.1). It carries a
 * Maka code directly because no executor code was involved, and it travels the
 * same path as a domain refusal so neither escapes as an unmapped exception.
 */
class MakaCuHostRefusal extends Error {
  constructor(
    readonly code: ComputerUseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MakaCuHostRefusal';
  }
}

export function createMakaCuBackend(opts: MakaCuBackendOptions): CuDispatchBackend & {
  executorState: () => MakaCuServiceSnapshot;
  clearSession: (sessionId: string) => void;
  dispose: () => void;
} {
  const imageDir = opts.imageDir ?? join(tmpdir(), `maka-cu-images-${process.pid}-${randomUUID()}`);
  const snapshots = new Map<string, StoredSnapshot>();
  const snapshotIdsBySession = new Map<string, string[]>();
  const begunSessions = new Set<string>();
  const sessionGenerations = new Map<string, number>();
  const operationQueues = new Map<string, Promise<void>>();
  let sessionClearReleaseEvents: MakaCuReleaseEvent[] | undefined;
  let disposed = false;

  function trace(event: MakaCuTraceEvent): void {
    try {
      opts.onTrace?.(event);
    } catch {
      // Diagnostics must never change dispatch.
    }
  }

  function clearLocalSession(sessionId: string): void {
    for (const id of snapshotIdsBySession.get(sessionId) ?? []) snapshots.delete(id);
    snapshotIdsBySession.delete(sessionId);
    begunSessions.delete(sessionId);
    sessionGenerations.set(sessionId, (sessionGenerations.get(sessionId) ?? 0) + 1);
  }

  function applyServiceRelease(events: readonly MakaCuReleaseEvent[]): void {
    const generationReleased = events.some((event) => event.generationReleased);
    const sessions = [
      ...new Set([
        ...events.flatMap((event) => event.sessionIds),
        // A dead generation took every snapshot and every session with it: §4.1
        // guarantees ids from the previous generation fail `snapshot_unknown`,
        // never silently resolve, so the host must stop quoting them.
        ...(generationReleased ? begunSessions : []),
        ...(generationReleased
          ? [...snapshots.values()].map((snapshot) => snapshot.sessionId)
          : []),
      ]),
    ];
    for (const sessionId of sessions) {
      clearLocalSession(sessionId);
      try {
        opts.onSessionInvalidated?.({
          sessionId,
          reason: events[0]!.reason,
          outcomeUnknown: events.some((event) => event.outcomeUnknown),
        });
      } catch {
        // Host lifecycle observers cannot change service recovery.
      }
    }
  }

  const service = new MakaCuService({
    binaryPath: opts.binaryPath,
    imageDir,
    hostVersion: opts.hostVersion ?? '0.0.0',
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: opts.handshakeTimeoutMs }),
    ...(opts.maxRestartAttempts === undefined
      ? {}
      : { maxRestartAttempts: opts.maxRestartAttempts }),
    ...(opts.restartBackoffMs === undefined ? {} : { restartBackoffMs: opts.restartBackoffMs }),
    ...(opts.expectedBinarySha256 === undefined
      ? {}
      : { expectedBinarySha256: opts.expectedBinarySha256 }),
    ...(opts.protocolVersion === undefined ? {} : { protocolVersion: opts.protocolVersion }),
    onRelease: (event) => {
      if (event.reason === 'disposed') return;
      if (event.reason === 'session_cleared' && sessionClearReleaseEvents) {
        sessionClearReleaseEvents.push(event);
        return;
      }
      applyServiceRelease([event]);
    },
  });

  async function withOperationQueue<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    sessionId?: string,
  ): Promise<T> {
    if (disposed) throw new Error('maka-cu backend disposed');
    // §9 gives the executor per-target lanes; the host queue stays upstream of
    // them so one Maka turn never has two dispatches in flight at once.
    const queueKey = '__executor__';
    const sessionGeneration =
      sessionId === undefined ? undefined : (sessionGenerations.get(sessionId) ?? 0);
    const previous = operationQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    operationQueues.set(queueKey, current);
    await previous;
    try {
      if (disposed) throw new Error('maka-cu backend disposed');
      if (signal.aborted) throw new Error('aborted');
      if (
        sessionId !== undefined &&
        (sessionGenerations.get(sessionId) ?? 0) !== sessionGeneration
      ) {
        throw new MakaCuSessionCleared();
      }
      if (!sessionId) return await operation();
      return await service.withSession(sessionId, operation);
    } finally {
      release();
      if (operationQueues.get(queueKey) === current) operationQueues.delete(queueKey);
    }
  }

  /** Translate an executor or transport failure into a Maka outcome. */
  function backendFailure(method: string, error: unknown): CaptureFailure | undefined {
    if (error instanceof MakaCuSessionCleared) return failure('aborted', error.message);
    if (error instanceof MakaCuDomainRefusal) {
      // A refusal is an outcome the model must read (§1.1), wherever in the
      // sequence it was raised.
      return domainFailure(error.method, error.domain);
    }
    if (error instanceof MakaCuHostRefusal) return failure(error.code, error.message);
    if (isMakaCuLifecycleError(error)) {
      return failure(error.code === 'aborted' ? 'aborted' : error.code, error.message);
    }
    if (error instanceof MakaCuProtocolViolation) {
      trace({ type: 'protocol_violation', method, reason: error.reason });
      // §6.3: a response the protocol forbids means the executor is not the one
      // this host negotiated with. The session is compromised, not retryable.
      service.reportProtocolViolation();
      return failure('service_mismatch', error.message);
    }
    if (error instanceof MakaCuRpcError) {
      if (error.body.code === MAKA_CU_RPC_ERROR.sessionUnknown) {
        return failure('stale_frame', 'the executor no longer holds this session; observe again');
      }
      if (error.body.code === MAKA_CU_RPC_ERROR.shuttingDown) {
        return failure('service_unavailable', 'maka-cu is shutting down');
      }
      // Every other JSON-RPC error means the host sent something unusable (§1.1),
      // which is a host bug rather than a fact about the screen.
      return failure('service_mismatch', error.message);
    }
    return undefined;
  }

  function domainFailure(
    method: string,
    error: MakaCuDomainError,
    toolCallId?: string,
    refusal?: MakaCuDispatchResult,
  ): CaptureFailure {
    trace({
      type: 'refusal',
      ...(toolCallId ? { toolCallId } : {}),
      method,
      code: error.code,
      ...(refusal
        ? {
            outcome: refusal.outcome,
            tier: refusal.tier,
            path: refusal.path,
            effect: refusal.effect,
          }
        : {}),
    });
    const mapped = mapMakaCuDomainError(error.code);
    if (!mapped) {
      // §7.1 is a closed table. An unknown code is version skew, and guessing a
      // Maka code for it is exactly the archaeology this protocol removes.
      service.reportProtocolViolation();
      return failure(
        'service_mismatch',
        `maka-cu answered ${method} with unknown error code '${error.code}'`,
      );
    }
    const detail = error.detail;
    const wouldRequirePath =
      detail && typeof detail.wouldRequirePath === 'string' ? detail.wouldRequirePath : undefined;
    return {
      outcome: {
        ok: false,
        error: mapped,
        // §1.2: `message` is a fixed sentence chosen by `code` and carries no
        // application content, so it passes through without a redaction pass.
        message: error.message,
        // §7.1: the executor's enum-only detail is the evidence the model gets.
        // `path` tells a refusal that was attempted and rejected from one where
        // nothing permitted could reach the target — which is what `path: none`
        // plus `wouldRequirePath` says, and is why one code covers both.
        ...(refusal || wouldRequirePath
          ? {
              evidence: {
                ...(refusal ? { path: refusal.path, effect: refusal.effect } : {}),
                ...(wouldRequirePath ? { reason: `would_require:${wouldRequirePath}` } : {}),
              },
            }
          : {}),
      },
    };
  }

  async function physicalInputFailure(): Promise<CaptureFailure | undefined> {
    if (!opts.physicalInputRecentlyActive) return undefined;
    try {
      if (!(await opts.physicalInputRecentlyActive())) return undefined;
    } catch {
      // The guard is a safety boundary. If the host cannot establish an idle
      // window, refuse the dispatch and require a fresh observation.
    }
    return failure(
      'user_intervened',
      'physical user input is active; wait for input to settle and observe again',
    );
  }

  function compatibilityInputBlocked(actionType: string): CaptureFailure {
    return failure(
      'unsupported_action',
      `background '${actionType}' is disabled because synthetic event dispatch can ` +
        "interfere with the user's physical input",
    );
  }

  // -------------------------------------------------------------------------
  // Sessions (§3) and snapshots (§4.1).
  // -------------------------------------------------------------------------

  async function ensureSession(sessionId: string, signal: AbortSignal): Promise<void> {
    if (begunSessions.has(sessionId)) return;
    const envelope = await service.call(
      'session.begin',
      // Observation is window-scoped in Maka, so the session's ScreenCaptureKit
      // filter is too; whole-display frames come from `screen.capture` (§6.6),
      // which is unaffected by the session scope.
      { session: sessionId, captureScope: 'window' },
      signal,
    );
    if (!envelope.ok) {
      throw new MakaCuDomainRefusal('session.begin', envelope.error);
    }
    begunSessions.add(sessionId);
  }

  function limits() {
    const negotiated = service.negotiated();
    if (!negotiated) throw new Error('maka-cu limits are unavailable before the handshake');
    return negotiated.limits;
  }

  function dropExpired(): void {
    const negotiated = service.negotiated();
    if (!negotiated) return;
    const oldest = Date.now() - negotiated.limits.snapshotTtlMs;
    for (const [id, snapshot] of snapshots) {
      if (snapshot.capturedAt < oldest) forgetSnapshot(id);
    }
  }

  function forgetSnapshot(snapshotId: string): void {
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot) return;
    snapshots.delete(snapshotId);
    const ids = snapshotIdsBySession.get(snapshot.sessionId);
    if (!ids) return;
    const index = ids.indexOf(snapshotId);
    if (index >= 0) ids.splice(index, 1);
    if (ids.length === 0) snapshotIdsBySession.delete(snapshot.sessionId);
  }

  function storeSnapshot(snapshot: MakaCuSnapshot, context: CuRunContext): void {
    dropExpired();
    // §4.1: supersession is scoped to (pid, windowId). A snapshot of another
    // window stays live, which is what lets a two-window turn keep working.
    for (const [id, stored] of snapshots) {
      if (
        stored.sessionId === context.sessionId &&
        stored.pid === snapshot.target.pid &&
        stored.windowId === snapshot.target.windowId
      ) {
        forgetSnapshot(id);
      }
    }
    const ids = snapshotIdsBySession.get(context.sessionId) ?? [];
    // The executor evicts oldest-first at `limits.snapshotsPerSession` (§4.1);
    // the host mirrors the bound rather than hardcoding one of its own.
    while (ids.length >= limits().snapshotsPerSession) forgetSnapshot(ids[0]!);
    const focusedToken = snapshot.focusedElementToken;
    const focusedDigest = focusedToken
      ? snapshot.elements.find((element) => element.token === focusedToken)?.digest
      : undefined;
    snapshots.set(snapshot.snapshotId, {
      sessionId: context.sessionId,
      turnId: context.turnId,
      snapshotId: snapshot.snapshotId,
      pid: snapshot.target.pid,
      windowId: snapshot.target.windowId,
      windowDigest: snapshot.windowDigest,
      capturedAt: snapshot.capturedAt,
      digests: new Map(snapshot.elements.map((element) => [element.token, element.digest])),
      modelIds: new Map(snapshot.elements.map((element, index) => [String(index), element.token])),
      ...(focusedToken && focusedDigest
        ? { focused: { token: focusedToken, digest: focusedDigest } }
        : {}),
    });
    snapshotIdsBySession.set(context.sessionId, [
      ...(snapshotIdsBySession.get(context.sessionId) ?? []),
      snapshot.snapshotId,
    ]);
  }

  function requireSnapshot(
    snapshotId: string,
    context: CuRunContext,
  ): StoredSnapshot | CaptureFailure {
    dropExpired();
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot) {
      return failure('stale_frame', 'observation is missing or already consumed');
    }
    if (snapshot.sessionId !== context.sessionId || snapshot.turnId !== context.turnId) {
      return failure('stale_frame', 'observation belongs to another session or turn');
    }
    return snapshot;
  }

  /**
   * The live snapshot a bound action quotes. Coordinate dispatch needs its
   * window digest (§6.3) and key dispatch needs its focus token (§6.4); neither
   * arrives with an observation id of its own, so the bound target names it.
   */
  function boundSnapshot(context: CuRunContext): StoredSnapshot | CaptureFailure {
    const target = context.boundAction?.target;
    if (!target) {
      return failure('no_active_frame', 'this action requires a bound observation');
    }
    dropExpired();
    const candidates = [...snapshots.values()].filter(
      (snapshot) =>
        snapshot.sessionId === context.sessionId &&
        snapshot.turnId === context.turnId &&
        snapshot.pid === target.pid &&
        snapshot.windowId === target.windowId,
    );
    const newest = candidates.sort((a, b) => b.capturedAt - a.capturedAt)[0];
    return (
      newest ??
      failure('stale_frame', 'no live observation of the bound window; observe before acting')
    );
  }

  // -------------------------------------------------------------------------
  // Images (§8) and observation shaping (§5).
  // -------------------------------------------------------------------------

  async function readFrame(image: MakaCuImage): Promise<CuScreenshot | CaptureFailure> {
    let bytes: Buffer;
    try {
      bytes = await readFile(image.path);
    } catch {
      // §8: the file's lifetime is its snapshot's. A path that no longer reads
      // is a spent frame, never a previous frame's pixels.
      return failure('capture_failed', 'the captured frame is no longer available');
    }
    if (bytes.byteLength !== image.byteLength) {
      service.reportProtocolViolation();
      return failure('service_mismatch', 'captured frame length does not match the declared bytes');
    }
    // §1.3: the host prefixes its own digest before comparing. Comparing bare
    // hex against the executor's `sha256:`-prefixed value made every frame
    // mismatch, and the host's answer to a mismatched frame is teardown.
    const digest = hostDigest(createHash('sha256').update(bytes).digest('hex'));
    if (digest !== image.sha256) {
      service.reportProtocolViolation();
      return failure(
        'service_mismatch',
        'captured frame digest does not match the declared sha256',
      );
    }
    let base64 = bytes.toString('base64');
    let mimeType: 'image/png' | 'image/jpeg' = image.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    let byteLength = bytes.byteLength;
    if (opts.compressFrame && byteLength > FRAME_COMPRESS_THRESHOLD_BYTES) {
      const compressed = opts.compressFrame(base64, mimeType);
      base64 = compressed.base64;
      mimeType = compressed.mimeType;
      byteLength = Buffer.from(base64, 'base64').byteLength;
    }
    if (exceedsFrameCap(byteLength)) {
      return failure('sensitivity_blocked', `window frame ${byteLength}B exceeds cap`);
    }
    return { base64, mimeType, widthPx: image.widthPx, heightPx: image.heightPx };
  }

  /**
   * §5.3: the wire frame is window-local and `CuObservedElement.frame` is screen
   * logical points for every backend, so the conversion happens here, in the one
   * function that holds both the element and the window origin, and nowhere
   * else. `validateSemanticElementVisibility` compares this rectangle's centre
   * against the window bounds in screen space and the agent cursor is drawn at
   * it; passing the window-local value straight through makes both wrong by the
   * window's origin, silently.
   */
  function toObservedElement(
    element: MakaCuElement,
    origin: ComputerUseRect,
    modelId: string,
  ): CuObservedElement {
    return {
      // The model quotes this back, so it is the short one; `identity.token`
      // below keeps the wire token, and dispatch maps back through the
      // snapshot's `modelIds`. The protocol's rule is that the EXECUTOR must
      // not re-resolve an index against a fresh tree — it never sees this id.
      elementId: modelId,
      role: element.role,
      ...(element.label ? { label: element.label } : {}),
      ...(element.value !== undefined ? { value: element.value } : {}),
      enabled: element.enabled,
      ...(element.selected === null ? {} : { selected: element.selected }),
      ...(element.parentToken ? { parentElementId: element.parentToken } : {}),
      frame: {
        x: element.frameInWindow.x + origin.x,
        y: element.frameInWindow.y + origin.y,
        width: element.frameInWindow.width,
        height: element.frameInWindow.height,
      },
      identity: {
        token: element.token,
        role: element.role,
        ...(element.label ? { label: element.label } : {}),
        ...(element.value !== undefined ? { value: element.value } : {}),
      },
    };
  }

  function toDisplays(snapshot: MakaCuSnapshot): ComputerUseDisplayIdentity[] | undefined {
    return snapshot.displays.length > 0
      ? snapshot.displays.map((display) => ({
          displayId: display.displayId,
          logicalBounds: display.logicalBounds,
          sourceBoundsPx: display.sourceBoundsPx,
          scaleFactor: display.scaleFactor,
        }))
      : undefined;
  }

  async function toObservation(
    snapshot: MakaCuSnapshot,
    context: CuRunContext,
  ): Promise<CuObservation | CaptureFailure> {
    let screenshot: CuScreenshot | undefined;
    if (snapshot.image) {
      const frame = await readFrame(snapshot.image);
      if ('outcome' in frame) return frame;
      screenshot = frame;
    }
    storeSnapshot(snapshot, context);
    trace({
      type: 'observe',
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      snapshotId: snapshot.snapshotId,
      pid: snapshot.target.pid,
      windowId: snapshot.target.windowId,
      elementCount: snapshot.elements.length,
      truncatedElements: snapshot.truncated.elements,
      truncatedDepth: snapshot.truncated.depth,
      truncatedTextElements: snapshot.elements.filter((element) => element.truncated.length > 0)
        .length,
    });
    const sourceBoundsPx: ComputerUseRect | undefined = snapshot.image
      ? { x: 0, y: 0, width: snapshot.image.widthPx, height: snapshot.image.heightPx }
      : undefined;
    const displays = toDisplays(snapshot);
    return {
      // The protocol's snapshot id IS the observation id: a dispatch quotes it
      // straight back, so the two identity spaces never need joining by hand.
      observationId: snapshot.snapshotId,
      // §5.1: one namespace. The executor states the `appId`; the host neither
      // builds one out of display strings nor hands the model a second spelling
      // to guess between.
      appId: snapshot.target.appId,
      pid: snapshot.target.pid,
      windowId: snapshot.target.windowId,
      ...(snapshot.target.title ? { windowTitle: snapshot.target.title } : {}),
      capturedAt: snapshot.capturedAt,
      windowBounds: snapshot.target.bounds,
      ...(sourceBoundsPx ? { sourceBoundsPx } : {}),
      zIndex: snapshot.target.zIndex,
      // §4.3: the window digest already is a content fingerprint over every
      // element digest plus bounds and title, computed where the tree lives.
      contentFingerprint: snapshot.windowDigest,
      ...(displays ? { displays } : {}),
      elements: snapshot.elements.map((element, index) =>
        toObservedElement(element, snapshot.target.bounds, String(index)),
      ),
      ...(screenshot ? { screenshot } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Observe (§5).
  // -------------------------------------------------------------------------

  async function listWindows(sessionId: string, signal: AbortSignal): Promise<MakaCuWindow[]> {
    const envelope = await service.call('window.list', { session: sessionId }, signal);
    if (!envelope.ok) throw new MakaCuDomainRefusal('window.list', envelope.error);
    const windows = envelope.windows;
    if (!Array.isArray(windows)) {
      throw new MakaCuProtocolViolation('window.list', 'windows is not an array');
    }
    // Dropping an entry the host could not read would hide a window from the
    // occlusion sort and from the id→pid join, and the entry it hid is exactly
    // the one that was malformed.
    return windows.map((entry) => readWindow('window.list', entry));
  }

  /**
   * §5.2: `target` is a tagged union, never a bag of optional fields — "app OR
   * window_id" is exactly the disagreement that made a compliant model fail on a
   * real machine. The host resolves its own two-optional API into one arm here:
   * an app alone goes to the executor, which owns the window inventory and the
   * z-order (§5.2); a window id is resolved against `window.list` for its pid,
   * because that join is what the list is for (§5.4).
   */
  async function resolveTarget(
    input: { app?: string; windowId?: number },
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ kind: 'app'; app: string } | { kind: 'window'; pid: number; windowId: number }> {
    if (input.windowId === undefined && input.app) return { kind: 'app', app: input.app };
    const windows = await listWindows(sessionId, signal);
    if (input.windowId === undefined) {
      // Neither input: the frontmost usable window, which `window.list` declares
      // by ordering front-to-back with no zIndex ties.
      const winner = windows
        .filter((window) => window.layer === 0 && window.onScreen)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      if (!winner) {
        throw new MakaCuHostRefusal('target_missing', 'no visible window is available to observe');
      }
      return { kind: 'window', pid: winner.pid, windowId: winner.windowId };
    }
    // A window id is exact and numeric, and it is resolved whatever its layer or
    // on-screen state: the caller named one window, not "one of the visible ones".
    const winner = windows.find((window) => window.windowId === input.windowId);
    if (!winner) {
      throw new MakaCuHostRefusal('target_missing', `no window with id ${input.windowId} is open`);
    }
    // §5.1: both were supplied, so both must hold, and no window satisfies the
    // pair when they disagree. The comparison is against `appId` and nothing
    // else — matching `appName` or `title` is what made every {app, windowId}
    // pair for a bundle-identified app unresolvable, since the string the host
    // handed out was the bundle id and the strings it matched against were
    // display strings that never carry one.
    if (input.app && input.app !== winner.appId) {
      throw new MakaCuHostRefusal(
        'target_missing',
        `window ${input.windowId} does not belong to ${input.app}`,
      );
    }
    return { kind: 'window', pid: winner.pid, windowId: winner.windowId };
  }

  async function observe(
    input: { app?: string; windowId?: number; includeScreenshot: boolean },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation> {
    try {
      await ensureSession(context.sessionId, signal);
      const target = await resolveTarget(input, context.sessionId, signal);
      const envelope = await service.call(
        'observe',
        {
          session: context.sessionId,
          target,
          includeImage: input.includeScreenshot,
          // maxElements/maxDepth/maxTextChars are omitted so the executor applies
          // the bounds it declared at handshake (§5.2). A host-side copy of those
          // numbers is the drift this protocol removes.
        },
        signal,
      );
      if (!envelope.ok) throw new MakaCuDomainRefusal('observe', envelope.error);
      const snapshot = readSnapshot('observe', envelope.snapshot);
      const observation = await toObservation(snapshot, context);
      if ('outcome' in observation) {
        throw new Error(`${observation.outcome.error}: ${observation.outcome.message}`);
      }
      return observation;
    } catch (error) {
      // `observeApp` reports failure by throwing, so a refusal raised anywhere
      // in the sequence — session, window list, target resolution, observe —
      // travels in the message with its mapped code, the way the cua-driver
      // backend's does.
      const mapped =
        error instanceof MakaCuDomainRefusal
          ? domainFailure(error.method, error.domain, context.toolCallId)
          : backendFailure('observe', error);
      if (!mapped) throw error;
      throw new Error(`${mapped.outcome.error}: ${mapped.outcome.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch (§6).
  // -------------------------------------------------------------------------

  function dispatchOutcome(method: string, result: MakaCuDispatchResult): CuDispatchOutcome {
    // §6.5: `verified` is not a wire field. One bit, one producer.
    const verified = result.effect === 'confirmed';
    return {
      ok: true,
      tier: result.tier,
      verified,
      evidence: {
        path: result.path,
        effect: result.effect,
        // Enums only (§1.2). `unverifiable` with method `none` means never
        // checked; with `value_readback` it means checked and inconclusive.
        reason: `${method}:${result.verification.method}`,
      },
    };
  }

  async function completeDispatch(
    method: string,
    envelope: { ok: true } & Record<string, unknown>,
    quoted: StoredSnapshot,
    context: CuRunContext,
  ): Promise<CuRunResult> {
    // §1.1/§6.5: `outcome` selects the arm, and `readDispatchResult` rejects a
    // disagreement — an `ok: true` result may only say `outcome: "ok"`, and a
    // refusal arrives on the other arm carrying the same four fields.
    const result = readDispatchResult(method, envelope, MAKA_CU_ALLOW_GLOBAL_POINTER);
    trace({
      type: 'dispatch',
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      method,
      outcome: result.outcome,
      tier: result.tier,
      path: result.path,
      effect: result.effect,
      verificationMethod: result.verification.method,
      ...(result.settle ? { settleMs: result.settle.waitedMs } : {}),
    });
    const outcome = dispatchOutcome(method, result);
    if (!result.snapshot) {
      // §4.1: a mutating dispatch that returned ok spent the frame it quoted,
      // and no fresh one arrived to supersede it, so drop it here.
      forgetSnapshot(quoted.snapshotId);
      // The window being gone is not an unknown outcome. It is the outcome.
      //
      // Closing a dialog, dismissing a sheet, closing a window and quitting an
      // app all end with the thing that was acted on no longer existing, so the
      // post-action observation cannot succeed and never will. Reporting that
      // as `outcome_unknown` tells a model "I do not know whether this worked",
      // and the obvious response to not knowing is to do it again — which for a
      // close is a second close, aimed at whatever took the window's place.
      //
      // Measured against the CUA Lab fixture: pressing the modal's own close
      // button reported `outcome_unknown: the target window no longer exists`,
      // on an action that had plainly succeeded.
      if (result.postObservationError?.code === 'window_gone' && result.outcome === 'ok') {
        return {
          outcome: {
            ...outcome,
            evidence: {
              ...outcome.evidence,
              // Not a new `effect`: that set is closed and model-facing, and
              // "unverifiable" is still the truthful reading of an effect no
              // readback could confirm. What changes is that the reason names
              // *why* nothing could be read back, so the answer is "it was
              // delivered and the target is gone" rather than "who knows".
              reason: `${method}:target_closed`,
            },
          },
        };
      }
      // §6.1: the action happened and must be reported even though the frame
      // after it could not be. Same host policy as the cua-driver backend: a
      // delivered dispatch without a fresh frame is outcome_unknown.
      return {
        outcome: {
          ok: false,
          error: 'outcome_unknown',
          message:
            result.postObservationError?.message ??
            `${method} was delivered but no post-action observation was returned`,
          evidence: { path: result.path, effect: 'unverifiable' },
        },
      };
    }
    // Storing the fresh snapshot supersedes the quoted one for this
    // (pid, windowId), which is exactly the frame that was just spent.
    const observation = await toObservation(result.snapshot, context);
    if ('outcome' in observation) return observation;
    return {
      outcome,
      observation,
      ...(observation.screenshot ? { screenshot: observation.screenshot } : {}),
    };
  }

  function elementAction(
    action: CuSemanticAction,
  ): { wire: Record<string, unknown> } | { refusal: CaptureFailure } {
    switch (action.type) {
      case 'click_element':
        return { wire: { kind: 'click', button: 'left', count: 1 } };
      case 'set_value':
        return { wire: { kind: 'set_value', value: action.value } };
      case 'select_text':
        return { wire: { kind: 'select_text', text: action.text } };
      case 'secondary_action': {
        if (!(ELEMENT_ACTION_NAMES as readonly string[]).includes(action.action)) {
          // §5: the executor maps raw AX names; the host never sends `AXPress`,
          // and an unknown name is refused instead of being tried and failing
          // with "'X' is not a valid secondary action".
          return {
            refusal: failure(
              'unsupported_action',
              `secondary action '${action.action}' is outside the protocol's action set`,
            ),
          };
        }
        return { wire: { kind: 'secondary_action', action: action.action } };
      }
      default:
        return {
          refusal: failure('unsupported_action', `'${action.type}' is not an element action`),
        };
    }
  }

  async function dispatchElement(
    action: Exclude<CuSemanticAction, { type: 'press_key' }>,
    snapshot: StoredSnapshot,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult> {
    // The model quoted a short id; the wire takes the token.
    const elementToken = snapshot.modelIds.get(action.elementId) ?? action.elementId;
    const digest = snapshot.digests.get(elementToken);
    if (!digest) {
      return failure('stale_frame', 'element is not part of the quoted observation');
    }
    const resolved = elementAction(action);
    if ('refusal' in resolved) return resolved.refusal;
    const wire = resolved.wire;
    const capability = service.negotiated()?.capabilities.elementActions ?? [];
    const kind = String(wire.kind);
    if (!capability.includes(kind)) {
      return failure('unsupported_action', `maka-cu does not advertise element action '${kind}'`);
    }
    const intervention = await physicalInputFailure();
    if (intervention) return intervention;
    const envelope = await service.call(
      'dispatch.element',
      {
        session: context.sessionId,
        snapshotId: snapshot.snapshotId,
        toolCallId: context.toolCallId,
        elementToken,
        expectElementDigest: digest,
        // §6.1: element-level binding. `window` would refuse on any change
        // anywhere in the window, which is right for recycled row views and far
        // too strict for a toolbar with a clock in it; the host declares the
        // choice rather than letting either side guess.
        strictness: 'element',
        // §6.1: a semantic dispatch addresses an element, not a pixel, so a
        // foreign window above it has no bearing on whether AXPress reaches it.
        // Treating foreign windows as occlusion is what made every click on a
        // freshly launched (bottom of z-order) app fail.
        occlusionPolicy: 'same_app',
        action: wire,
        observeAfter: { includeImage: true, settle: 'quiesce' },
      },
      signal,
    );
    if (!envelope.ok) return refusedDispatch('dispatch.element', envelope, snapshot, context);
    return completeDispatch('dispatch.element', envelope, snapshot, context);
  }

  /** §4.1: a refused dispatch leaves the frame live; `outcome_unknown` spends it. */
  function forgetUnusableSnapshot(error: MakaCuDomainError, snapshot: StoredSnapshot): void {
    const unusable =
      error.code === 'outcome_unknown' ||
      error.code === 'snapshot_spent' ||
      error.code === 'snapshot_superseded' ||
      error.code === 'snapshot_expired' ||
      error.code === 'snapshot_evicted' ||
      error.code === 'snapshot_unknown' ||
      // §6.2: the token was real and the echoed digest was not the recorded one,
      // which means this host paired a token with a digest from another frame.
      // Re-sending against the same frame cannot help, so the frame goes.
      error.code === 'element_digest_mismatch';
    if (unusable) forgetSnapshot(snapshot.snapshotId);
  }

  /**
   * §1.1: the refusal arm carries `outcome`, `tier`, `path`, `effect` and
   * `verification` beside `error`, so it is read and checked exactly like the
   * success arm — a refusal missing any of them is version skew. What it is
   * *not* is a protocol violation: a non-`ok` outcome can no longer appear on
   * the `ok: true` arm, so this arm is the only place one can live, and tearing
   * the executor down for saying `refused` is how the two ends disagreed.
   */
  function refusedDispatch(
    method: string,
    envelope: Extract<MakaCuEnvelope, { ok: false }>,
    snapshot: StoredSnapshot,
    context: CuRunContext,
  ): CuRunResult {
    const refusal = readDispatchResult(method, envelope, MAKA_CU_ALLOW_GLOBAL_POINTER);
    forgetUnusableSnapshot(envelope.error, snapshot);
    return domainFailure(method, envelope.error, context.toolCallId, refusal);
  }

  async function dispatchKey(
    wire: Record<string, unknown>,
    snapshot: StoredSnapshot,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult> {
    if (opts.allowCompatibilityInputDispatch !== true) {
      return compatibilityInputBlocked(String(wire.kind));
    }
    if (!snapshot.focused) {
      // §6.4: focusToken is required and verified. Without a focused element in
      // the frame we quoted there is nothing to verify against, and typing into
      // "whatever is focused now" is the defect this replaces.
      return failure(
        'unsupported_action',
        'the observed window had no focused element; click the field and observe again',
      );
    }
    const capability = service.negotiated()?.capabilities.keyActions ?? [];
    if (!capability.includes(String(wire.kind))) {
      return failure(
        'unsupported_action',
        `maka-cu does not advertise key action '${String(wire.kind)}'`,
      );
    }
    const intervention = await physicalInputFailure();
    if (intervention) return intervention;
    const envelope = await service.call(
      'dispatch.key',
      {
        session: context.sessionId,
        snapshotId: snapshot.snapshotId,
        toolCallId: context.toolCallId,
        focusToken: snapshot.focused.token,
        expectElementDigest: snapshot.focused.digest,
        action: wire,
        observeAfter: { includeImage: true, settle: 'quiesce' },
      },
      signal,
    );
    if (!envelope.ok) return refusedDispatch('dispatch.key', envelope, snapshot, context);
    return completeDispatch('dispatch.key', envelope, snapshot, context);
  }

  async function dispatchPoint(
    wire: Record<string, unknown>,
    point: { x: number; y: number },
    startPoint: { x: number; y: number } | undefined,
    snapshot: StoredSnapshot,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult> {
    if (opts.allowCompatibilityInputDispatch !== true) {
      return compatibilityInputBlocked(String(wire.kind));
    }
    const capability = service.negotiated()?.capabilities.pointActions ?? [];
    if (!capability.includes(String(wire.kind))) {
      return failure(
        'unsupported_action',
        `maka-cu does not advertise point action '${String(wire.kind)}'`,
      );
    }
    const intervention = await physicalInputFailure();
    if (intervention) return intervention;
    const envelope = await service.call(
      'dispatch.point',
      {
        session: context.sessionId,
        snapshotId: snapshot.snapshotId,
        toolCallId: context.toolCallId,
        // §6.3: a point has no element to anchor to, so the window is the anchor.
        expectWindowDigest: snapshot.windowDigest,
        point,
        ...(startPoint ? { startPoint } : {}),
        space: 'image_px',
        // §6.3: a pixel is a pixel — anything on top of it owns it.
        occlusionPolicy: 'any',
        action: wire,
        observeAfter: { includeImage: true, settle: 'quiesce' },
      },
      signal,
    );
    if (!envelope.ok) return refusedDispatch('dispatch.point', envelope, snapshot, context);
    return completeDispatch('dispatch.point', envelope, snapshot, context);
  }

  /** The model's coordinate, in the image pixels the protocol asks for (§6.3). */
  function boundImagePoint(
    context: CuRunContext,
    which: 'end' | 'start',
  ): { x: number; y: number } | undefined {
    const bound = context.boundAction;
    if (!bound || bound.coordinateSpace !== 'window-screenshot-local') return undefined;
    return which === 'start' ? bound.windowStartCoordinate : bound.windowCoordinate;
  }

  function pointActionFor(action: CuAction): { kind: string; [key: string]: unknown } | undefined {
    switch (action.type) {
      case 'mouse_move':
        return { kind: 'move' };
      case 'left_click':
        return { kind: 'left_click', count: 1 };
      case 'right_click':
        return { kind: 'right_click' };
      case 'middle_click':
        return { kind: 'middle_click' };
      case 'double_click':
        return { kind: 'double_click' };
      case 'triple_click':
        return { kind: 'triple_click' };
      case 'left_mouse_down':
        return { kind: 'mouse_down' };
      case 'left_mouse_up':
        return { kind: 'mouse_up' };
      case 'left_click_drag':
        return { kind: 'drag' };
      case 'scroll':
        return {
          kind: 'scroll',
          direction: action.scrollDirection,
          pages: action.scrollAmount / SCROLL_UNITS_PER_PAGE,
        };
      default:
        return undefined;
    }
  }

  /**
   * §6.4: the host parses, before it sends. Maka's callers hold xdotool-flavoured
   * strings (`CuAction.key.text`, `CuSemanticAction.press_key.key`) while the
   * wire declares a closed set of named keys plus single printable characters
   * with modifiers in their own array. Forwarding the raw string earned a
   * `-32602` — a JSON-RPC error, which per §1.1 never describes the world —
   * which `backendFailure` then reported as `service_mismatch`, telling the
   * model the executor was the wrong version when it had asked for Cmd+A.
   *
   * An unparseable string fails the action here, with the string named. Nothing
   * reaches `dispatch.key`: a dropped modifier or a nearest match is a key press
   * the user did not ask for and cannot see.
   */
  function keyAction(raw: string): { wire: Record<string, unknown> } | { refusal: CaptureFailure } {
    const chord = parseMakaCuKeyChord(raw);
    if (!chord) {
      return {
        refusal: failure(
          'unsupported_action',
          `'${raw}' is not a key this protocol can express; name one key, ` +
            'optionally after modifiers (for example cmd+a, shift+Tab, Return), ' +
            'and say Backspace or ForwardDelete rather than delete',
        ),
      };
    }
    return { wire: { kind: 'key', key: chord.key, modifiers: chord.modifiers } };
  }

  async function captureScreen(signal: AbortSignal, context: CuRunContext): Promise<CuRunResult> {
    await ensureSession(context.sessionId, signal);
    const envelope = await service.call('screen.capture', { session: context.sessionId }, signal);
    if (!envelope.ok) return domainFailure('screen.capture', envelope.error, context.toolCallId);
    const frame = await readFrame(readImageField('screen.capture', envelope.image));
    if ('outcome' in frame) return frame;
    return {
      outcome: { ok: true, tier: 'coordinate-background', evidence: { path: 'none' } },
      screenshot: frame,
    };
  }

  return {
    async preflight(signal) {
      return withOperationQueue(signal, async () => {
        // §5: `prompt: false` must not raise a TCC dialog — this runs at every
        // action start because the user can revoke at any time.
        const envelope = await service.call('permissions.check', { prompt: false }, signal);
        // A refusal here is the executor saying it cannot answer, which is not
        // the same as "granted"; fail closed so the runtime's per-action TCC
        // gate blocks rather than proceeds.
        if (!envelope.ok) return { accessibility: false, screenRecording: false };
        return {
          accessibility: envelope.accessibility === true,
          // §5: the executor states whether the boolean came from a live probe,
          // so the host no longer has to guess which it got.
          screenRecording: envelope.screenRecording === true,
        };
      });
    },

    async listApps(signal) {
      return withOperationQueue(signal, async (): Promise<CuAppSummary[]> => {
        try {
          const envelope = await service.call('apps.list', {}, signal);
          if (!envelope.ok) throw new MakaCuDomainRefusal('apps.list', envelope.error);
          const apps = envelope.apps;
          if (!Array.isArray(apps)) {
            throw new MakaCuProtocolViolation('apps.list', 'apps is not an array');
          }
          return apps.map((entry) => readApp('apps.list', entry));
        } catch (error) {
          // Like `observeApp`, this reports by throwing, so the mapped code
          // travels in the message rather than escaping as an unmapped one.
          const mapped =
            error instanceof MakaCuDomainRefusal
              ? domainFailure(error.method, error.domain)
              : backendFailure('apps.list', error);
          if (!mapped) throw error;
          throw new Error(`${mapped.outcome.error}: ${mapped.outcome.message}`);
        }
      });
    },

    async observeApp(input, signal, context) {
      return withOperationQueue(signal, () => observe(input, signal, context), context.sessionId);
    },

    async captureObservation(input, signal, context) {
      return withOperationQueue(signal, () => observe(input, signal, context), context.sessionId);
    },

    async runSemantic(action, signal, context) {
      try {
        return await withOperationQueue(
          signal,
          async () => {
            await ensureSession(context.sessionId, signal);
            const snapshot = requireSnapshot(action.observationId, context);
            if ('outcome' in snapshot) return snapshot;
            if (action.type === 'press_key') {
              const key = keyAction(action.key);
              if ('refusal' in key) return key.refusal;
              return dispatchKey(key.wire, snapshot, signal, context);
            }
            return dispatchElement(action, snapshot, signal, context);
          },
          context.sessionId,
        );
      } catch (error) {
        const mapped = backendFailure('runSemantic', error);
        if (mapped) return mapped;
        throw error;
      }
    },

    async run(action, signal, context) {
      try {
        return await withOperationQueue(
          signal,
          async (): Promise<CuRunResult> => {
            if (action.type === 'wait') {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(action.durationMs, 10_000)),
              );
              return { outcome: { ok: true, tier: 'coordinate-background' } };
            }
            if (action.type === 'screenshot') return captureScreen(signal, context);
            if (action.type === 'type' || action.type === 'key') {
              const wire =
                action.type === 'type'
                  ? { wire: { kind: 'type', text: action.text } as Record<string, unknown> }
                  : keyAction(action.text);
              if ('refusal' in wire) return wire.refusal;
              await ensureSession(context.sessionId, signal);
              const snapshot = boundSnapshot(context);
              if ('outcome' in snapshot) return snapshot;
              return dispatchKey(wire.wire, snapshot, signal, context);
            }
            const wire = pointActionFor(action);
            if (!wire) {
              // `cursor_position`, `hold_key` and `zoom` have no maka.cu/2
              // method. Reading the cursor is meaningless for an executor that
              // never moves it, and the other two are not in the protocol's
              // action sets — feature detection, not silent degradation.
              return failure(
                'unsupported_action',
                `action '${action.type}' is not part of maka.cu/2`,
              );
            }
            await ensureSession(context.sessionId, signal);
            const snapshot = boundSnapshot(context);
            if ('outcome' in snapshot) return snapshot;
            const point = boundImagePoint(context, 'end');
            if (!point) {
              return failure(
                'invalid_coordinate',
                'the bound action carries no window-screenshot-local coordinate',
              );
            }
            const startPoint =
              action.type === 'left_click_drag' ? boundImagePoint(context, 'start') : undefined;
            if (action.type === 'left_click_drag' && !startPoint) {
              return failure(
                'invalid_coordinate',
                'drag requires a bound start coordinate in the same space',
              );
            }
            return dispatchPoint(wire, point, startPoint, snapshot, signal, context);
          },
          context.sessionId,
        );
      } catch (error) {
        const mapped = backendFailure('run', error);
        if (mapped) return mapped;
        throw error;
      }
    },

    executorState() {
      return service.snapshot();
    },

    clearSession(sessionId) {
      const releases: MakaCuReleaseEvent[] = [];
      sessionClearReleaseEvents = releases;
      try {
        service.clearSession(sessionId);
      } finally {
        sessionClearReleaseEvents = undefined;
      }
      const wasBegun = begunSessions.has(sessionId);
      if (releases.length > 0) applyServiceRelease(releases);
      else clearLocalSession(sessionId);
      // A released generation already dropped every session with it, and a dead
      // child must not be respawned merely to end a session that no longer
      // exists — §4.1 guarantees its snapshot ids can never resolve again.
      if (!wasBegun || disposed || service.snapshot().state !== 'ready') return;
      // §3: `session.end` drops every snapshot, deletes every image the session
      // produced and removes any executor-drawn cursor. Maka has already been
      // bitten by an agent cursor outliving the run that drew it, so this is
      // fired even though the host has forgotten the session locally.
      void service.call('session.end', { session: sessionId }).catch(() => {
        // Teardown is idempotent (§3) and the executor ends every session on
        // SIGTERM anyway; a failure here must not break session cleanup.
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      snapshots.clear();
      snapshotIdsBySession.clear();
      begunSessions.clear();
      sessionGenerations.clear();
      service.dispose();
    },
  };
}
