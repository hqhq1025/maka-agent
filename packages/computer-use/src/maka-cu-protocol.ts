// The `maka.cu/1` wire contract, host side. Mirrors
// docs/maka-cu-host-protocol.md; section numbers in comments refer to it.
//
// Everything here is parsing and mapping only: closed sets are checked against
// the tables the protocol declares, and anything outside them is a protocol
// violation rather than a value to coerce. That is the whole point of the
// protocol — the previous backend had to guess a dispatch tier from an
// unrecognised path string, and every guess it made was `coordinate-background`.
import {
  COMPUTER_USE_DISPATCH_TIERS,
  COMPUTER_USE_EFFECTS,
  type ComputerUseDispatchTier,
  type ComputerUseEffect,
  type ComputerUseErrorCode,
  type ComputerUseRect,
} from '@maka/core';

export const MAKA_CU_PROTOCOL_VERSION = 'maka.cu/1';

/** JSON-RPC error codes (§1.1). These describe the request, never the world. */
export const MAKA_CU_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  unknownMethod: -32601,
  invalidParams: -32602,
  internal: -32603,
  protocolVersionMismatch: -32000,
  handshakeRequired: -32001,
  sessionUnknown: -32002,
  shuttingDown: -32003,
} as const;

/**
 * §2/§6.3: the only value Maka ships. It is declared once because the handshake
 * that sends it and the dispatch reader that verifies the executor honoured it
 * must never be able to disagree.
 */
export const MAKA_CU_ALLOW_GLOBAL_POINTER = false;

export interface MakaCuRpcErrorBody {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface MakaCuRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: MakaCuRpcErrorBody;
}

/** A `result` envelope (§1.1): the tagged union that carries the world. */
export type MakaCuEnvelope =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: MakaCuDomainError };

export interface MakaCuDomainError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// §7.1 domain code → Maka error code. Mechanical, no inference, no message
// matching. A code absent from this table is version skew, not a default.
// ---------------------------------------------------------------------------
const DOMAIN_ERROR_CODES: Record<string, ComputerUseErrorCode> = {
  snapshot_unknown: 'stale_frame',
  snapshot_expired: 'stale_frame',
  snapshot_evicted: 'stale_frame',
  element_unknown: 'stale_frame',
  snapshot_spent: 'duplicate_action',
  snapshot_superseded: 'stale_epoch',
  element_released: 'target_missing',
  window_gone: 'target_missing',
  process_replaced: 'target_missing',
  app_not_found: 'target_missing',
  element_changed: 'target_changed',
  window_changed: 'target_changed',
  focus_changed: 'target_changed',
  window_occluded: 'target_occluded',
  element_not_actionable: 'unsupported_action',
  element_disabled: 'unsupported_action',
  unsupported_action: 'unsupported_action',
  not_implemented: 'unsupported_action',
  permission_missing: 'permission_missing',
  screen_locked: 'screen_locked',
  physical_input_active: 'user_intervened',
  invalid_point: 'invalid_coordinate',
  capture_failed: 'capture_failed',
  response_too_large: 'capture_failed',
  image_write_failed: 'capture_failed',
  outcome_unknown: 'outcome_unknown',
  aborted: 'aborted',
  timeout: 'timeout',
  // §7.1 leaves `dispatch_refused` unmapped because COMPUTER_USE_ERROR_CODES has
  // no member meaning "attempted, the OS refused, nothing happened". Of the
  // members that exist, `unsupported_action` is the only one whose host response
  // (§6.2: tell the model) matches; `capture_failed`, which the cua-driver
  // backend falls back to, tells the model a screenshot broke when a button
  // refused a press. The executor's `detail` still reaches the model as evidence.
  dispatch_refused: 'unsupported_action',
};

/** `undefined` means this host does not know the code — treat as version skew. */
export function mapMakaCuDomainError(code: string): ComputerUseErrorCode | undefined {
  return Object.hasOwn(DOMAIN_ERROR_CODES, code) ? DOMAIN_ERROR_CODES[code] : undefined;
}

// ---------------------------------------------------------------------------
// §6.3/§6.5 declared dispatch fields.
// ---------------------------------------------------------------------------
export const MAKA_CU_DISPATCH_OUTCOMES = ['ok', 'refused', 'failed', 'unknown'] as const;
export type MakaCuDispatchOutcome = (typeof MAKA_CU_DISPATCH_OUTCOMES)[number];

export const MAKA_CU_DISPATCH_PATHS = [
  'ax_action',
  'ax_attribute',
  'ax_select',
  'cg_event_pid',
  'skylight_pid',
  'cg_event_global',
  'none',
] as const;
export type MakaCuDispatchPath = (typeof MAKA_CU_DISPATCH_PATHS)[number];

export const MAKA_CU_VERIFICATION_METHODS = [
  'none',
  'action_result',
  'value_readback',
  'selection_readback',
  'focus_readback',
  'tree_delta',
] as const;
export type MakaCuVerificationMethod = (typeof MAKA_CU_VERIFICATION_METHODS)[number];

/** §6.3: the pairing is fixed. `none` is dispatched nothing, so it pairs with any tier. */
const PATHS_BY_TIER: Record<ComputerUseDispatchTier, readonly MakaCuDispatchPath[]> = {
  ax: ['ax_action', 'ax_attribute', 'ax_select'],
  // Reserved for a future page-level path (`cdp`); no path is legal there yet.
  'semantic-background': [],
  'coordinate-background': ['cg_event_pid', 'skylight_pid', 'cg_event_global'],
};

/** §6.3: moves the system cursor, so it needs `allowGlobalPointer: true`. */
const GLOBAL_POINTER_PATHS: readonly MakaCuDispatchPath[] = ['cg_event_global'];

export interface MakaCuVerification {
  method: MakaCuVerificationMethod;
  observedChange: boolean;
}

export interface MakaCuSettle {
  waitedMs: number;
  quiesced: boolean;
  reason: string;
}

export interface MakaCuDispatchResult {
  toolCallId: string;
  outcome: MakaCuDispatchOutcome;
  tier: ComputerUseDispatchTier;
  path: MakaCuDispatchPath;
  effect: ComputerUseEffect;
  verification: MakaCuVerification;
  settle?: MakaCuSettle;
  snapshot?: MakaCuSnapshot;
  postObservationError?: MakaCuDomainError;
}

// ---------------------------------------------------------------------------
// §5 observation.
// ---------------------------------------------------------------------------
export interface MakaCuElement {
  token: string;
  /** `null` for the root; `null` and absent are the same on the wire (§5). */
  parentToken: string | null;
  depth: number;
  role: string;
  subrole?: string;
  axIdentifier?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  enabled: boolean;
  focused: boolean;
  selected: boolean | null;
  /** Window-local logical points, origin at the window's top-left (§5). */
  frame: ComputerUseRect;
  actions: string[];
  digest: string;
  /** Which of this element's text fields were cut at `maxTextChars` (§5). */
  truncated: string[];
}

export interface MakaCuImage {
  path: string;
  format: 'png' | 'jpeg';
  widthPx: number;
  heightPx: number;
  byteLength: number;
  sha256: string;
  /** Measured `widthPx / target.bounds.width`, not `NSScreen.backingScaleFactor` (§5). */
  scale: number;
}

export interface MakaCuDisplay {
  displayId: string;
  logicalBounds: ComputerUseRect;
  sourceBoundsPx: ComputerUseRect;
  scaleFactor: number;
}

export interface MakaCuSnapshotTarget {
  pid: number;
  windowId: number;
  bundleId?: string | null;
  appName?: string | null;
  title?: string | null;
  bounds: ComputerUseRect;
  layer: number;
  zIndex: number;
  displayId?: string | null;
}

export interface MakaCuSnapshot {
  snapshotId: string;
  capturedAt: number;
  target: MakaCuSnapshotTarget;
  windowDigest: string;
  focusedElementToken: string | null;
  selectedText: { text: string; truncated: boolean } | null;
  image: MakaCuImage | null;
  displays: MakaCuDisplay[];
  obscuringRects: ComputerUseRect[];
  elements: MakaCuElement[];
  truncated: { elements: boolean; depth: boolean };
}

// ---------------------------------------------------------------------------
// Parsing. Every reader below refuses rather than defaults: a missing declared
// field is a protocol violation, and the host that papers over one is the host
// that cannot tell a broken executor from a working one.
// ---------------------------------------------------------------------------

export class MakaCuProtocolViolation extends Error {
  constructor(
    readonly method: string,
    readonly reason: string,
  ) {
    super(`maka-cu protocol violation in ${method}: ${reason}`);
    this.name = 'MakaCuProtocolViolation';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(method: string, value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MakaCuProtocolViolation(method, `${what} is not an object`);
  return value;
}

function requireString(method: string, value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MakaCuProtocolViolation(method, `${what} is not a non-empty string`);
  }
  return value;
}

function requireNumber(method: string, value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MakaCuProtocolViolation(method, `${what} is not a finite number`);
  }
  return value;
}

function requireBoolean(method: string, value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new MakaCuProtocolViolation(method, `${what} is not a boolean`);
  }
  return value;
}

function requireMember<T extends string>(
  method: string,
  value: unknown,
  members: readonly T[],
  what: string,
): T {
  if (typeof value !== 'string' || !(members as readonly string[]).includes(value)) {
    throw new MakaCuProtocolViolation(method, `${what} is outside its closed set`);
  }
  return value as T;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireRect(method: string, value: unknown, what: string): ComputerUseRect {
  const rect = requireRecord(method, value, what);
  return {
    x: requireNumber(method, rect.x, `${what}.x`),
    y: requireNumber(method, rect.y, `${what}.y`),
    width: requireNumber(method, rect.width, `${what}.width`),
    height: requireNumber(method, rect.height, `${what}.height`),
  };
}

/** Split a `result` into the protocol's two arms; anything else is a violation. */
export function readEnvelope(method: string, result: unknown): MakaCuEnvelope {
  const record = requireRecord(method, result, 'result');
  if (record.ok === true) return record as { ok: true } & Record<string, unknown>;
  if (record.ok !== false) throw new MakaCuProtocolViolation(method, 'result.ok is not a boolean');
  const error = requireRecord(method, record.error, 'result.error');
  return {
    ok: false,
    error: {
      code: requireString(method, error.code, 'result.error.code'),
      message: requireString(method, error.message, 'result.error.message'),
      ...(isRecord(error.detail) ? { detail: error.detail } : {}),
    },
  };
}

export function readElement(method: string, value: unknown): MakaCuElement {
  const element = requireRecord(method, value, 'element');
  const truncated = element.truncated;
  if (!Array.isArray(truncated)) {
    throw new MakaCuProtocolViolation(method, 'element.truncated is not an array');
  }
  const actions = element.actions;
  if (!Array.isArray(actions)) {
    throw new MakaCuProtocolViolation(method, 'element.actions is not an array');
  }
  return {
    token: requireString(method, element.token, 'element.token'),
    parentToken: optionalString(element.parentToken) ?? null,
    depth: requireNumber(method, element.depth, 'element.depth'),
    role: requireString(method, element.role, 'element.role'),
    ...(optionalString(element.subrole) ? { subrole: element.subrole as string } : {}),
    ...(optionalString(element.axIdentifier)
      ? { axIdentifier: element.axIdentifier as string }
      : {}),
    ...(typeof element.label === 'string' ? { label: element.label } : {}),
    ...(typeof element.value === 'string' ? { value: element.value } : {}),
    ...(typeof element.placeholder === 'string' ? { placeholder: element.placeholder } : {}),
    enabled: requireBoolean(method, element.enabled, 'element.enabled'),
    focused: requireBoolean(method, element.focused, 'element.focused'),
    selected: typeof element.selected === 'boolean' ? element.selected : null,
    frame: requireRect(method, element.frame, 'element.frame'),
    actions: actions.map((action, index) =>
      requireString(method, action, `element.actions[${index}]`),
    ),
    digest: requireString(method, element.digest, 'element.digest'),
    truncated: truncated.map((field, index) =>
      requireString(method, field, `element.truncated[${index}]`),
    ),
  };
}

function readImage(method: string, value: unknown): MakaCuImage | null {
  if (value === null || value === undefined) return null;
  return readImageField(method, value);
}

/** Every image is a file reference; there is no inline branch to fall back to (§8). */
export function readImageField(method: string, value: unknown): MakaCuImage {
  const image = requireRecord(method, value, 'image');
  return {
    path: requireString(method, image.path, 'image.path'),
    format: requireMember(method, image.format, ['png', 'jpeg'] as const, 'image.format'),
    widthPx: requireNumber(method, image.widthPx, 'image.widthPx'),
    heightPx: requireNumber(method, image.heightPx, 'image.heightPx'),
    byteLength: requireNumber(method, image.byteLength, 'image.byteLength'),
    sha256: requireString(method, image.sha256, 'image.sha256'),
    scale: requireNumber(method, image.scale, 'image.scale'),
  };
}

export function readSnapshot(method: string, value: unknown): MakaCuSnapshot {
  const snapshot = requireRecord(method, value, 'snapshot');
  const target = requireRecord(method, snapshot.target, 'snapshot.target');
  const elements = snapshot.elements;
  if (!Array.isArray(elements)) {
    throw new MakaCuProtocolViolation(method, 'snapshot.elements is not an array');
  }
  const displays = Array.isArray(snapshot.displays) ? snapshot.displays : [];
  const obscuring = Array.isArray(snapshot.obscuringRects) ? snapshot.obscuringRects : [];
  const truncated = requireRecord(method, snapshot.truncated, 'snapshot.truncated');
  const selectedText = isRecord(snapshot.selectedText)
    ? {
        text: requireString(method, snapshot.selectedText.text, 'snapshot.selectedText.text'),
        truncated: requireBoolean(
          method,
          snapshot.selectedText.truncated,
          'snapshot.selectedText.truncated',
        ),
      }
    : null;
  return {
    snapshotId: requireString(method, snapshot.snapshotId, 'snapshot.snapshotId'),
    capturedAt: requireNumber(method, snapshot.capturedAt, 'snapshot.capturedAt'),
    target: {
      pid: requireNumber(method, target.pid, 'snapshot.target.pid'),
      windowId: requireNumber(method, target.windowId, 'snapshot.target.windowId'),
      ...(optionalString(target.bundleId) ? { bundleId: target.bundleId as string } : {}),
      ...(optionalString(target.appName) ? { appName: target.appName as string } : {}),
      ...(typeof target.title === 'string' ? { title: target.title } : {}),
      bounds: requireRect(method, target.bounds, 'snapshot.target.bounds'),
      layer: requireNumber(method, target.layer, 'snapshot.target.layer'),
      zIndex: requireNumber(method, target.zIndex, 'snapshot.target.zIndex'),
      ...(optionalString(target.displayId) ? { displayId: target.displayId as string } : {}),
    },
    windowDigest: requireString(method, snapshot.windowDigest, 'snapshot.windowDigest'),
    focusedElementToken: optionalString(snapshot.focusedElementToken) ?? null,
    selectedText,
    image: readImage(method, snapshot.image),
    displays: displays.map((display, index) => {
      const record = requireRecord(method, display, `snapshot.displays[${index}]`);
      return {
        displayId: requireString(method, record.displayId, 'display.displayId'),
        logicalBounds: requireRect(method, record.logicalBounds, 'display.logicalBounds'),
        sourceBoundsPx: requireRect(method, record.sourceBoundsPx, 'display.sourceBoundsPx'),
        scaleFactor: requireNumber(method, record.scaleFactor, 'display.scaleFactor'),
      };
    }),
    obscuringRects: obscuring.map((rect, index) =>
      requireRect(method, rect, `snapshot.obscuringRects[${index}]`),
    ),
    elements: elements.map((element) => readElement(method, element)),
    truncated: {
      elements: requireBoolean(method, truncated.elements, 'snapshot.truncated.elements'),
      depth: requireBoolean(method, truncated.depth, 'snapshot.truncated.depth'),
    },
  };
}

/**
 * §6.5 + §6.3: all four declared fields are required, and the tier/path pair is
 * rejected rather than coerced. `allowGlobalPointer` is verified here because
 * the executor states the path and the host checks it — a response whose path
 * was not permitted means the executor moved the system cursor, which is the
 * one invariant Maka does not trade.
 */
export function readDispatchResult(
  method: string,
  envelope: { ok: true } & Record<string, unknown>,
  allowGlobalPointer: boolean,
): MakaCuDispatchResult {
  const verification = requireRecord(method, envelope.verification, 'verification');
  const tier = requireMember(method, envelope.tier, COMPUTER_USE_DISPATCH_TIERS, 'tier');
  const path = requireMember(method, envelope.path, MAKA_CU_DISPATCH_PATHS, 'path');
  if (path !== 'none' && !PATHS_BY_TIER[tier].includes(path)) {
    throw new MakaCuProtocolViolation(method, `tier '${tier}' does not permit path '${path}'`);
  }
  if (!allowGlobalPointer && GLOBAL_POINTER_PATHS.includes(path)) {
    throw new MakaCuProtocolViolation(
      method,
      `path '${path}' moves the system cursor and was not permitted at handshake`,
    );
  }
  const settle = isRecord(envelope.settle)
    ? {
        waitedMs: requireNumber(method, envelope.settle.waitedMs, 'settle.waitedMs'),
        quiesced: requireBoolean(method, envelope.settle.quiesced, 'settle.quiesced'),
        reason: requireString(method, envelope.settle.reason, 'settle.reason'),
      }
    : undefined;
  const postObservationError = isRecord(envelope.postObservationError)
    ? {
        code: requireString(
          method,
          envelope.postObservationError.code,
          'postObservationError.code',
        ),
        message: requireString(
          method,
          envelope.postObservationError.message,
          'postObservationError.message',
        ),
      }
    : undefined;
  return {
    toolCallId: requireString(method, envelope.toolCallId, 'toolCallId'),
    outcome: requireMember(method, envelope.outcome, MAKA_CU_DISPATCH_OUTCOMES, 'outcome'),
    tier,
    path,
    effect: requireMember(method, envelope.effect, COMPUTER_USE_EFFECTS, 'effect'),
    verification: {
      method: requireMember(
        method,
        verification.method,
        MAKA_CU_VERIFICATION_METHODS,
        'verification.method',
      ),
      observedChange: requireBoolean(
        method,
        verification.observedChange,
        'verification.observedChange',
      ),
    },
    ...(settle ? { settle } : {}),
    ...(envelope.snapshot === null || envelope.snapshot === undefined
      ? {}
      : { snapshot: readSnapshot(method, envelope.snapshot) }),
    ...(postObservationError ? { postObservationError } : {}),
  };
}
