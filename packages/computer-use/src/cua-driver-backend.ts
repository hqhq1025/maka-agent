/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import type { ComputerUseErrorCode } from '@maka/core/computer-use';
import type {
  CuAppSummary,
  CuDispatchBackend,
  CuObservation,
  CuRunContext,
  CuRunResult,
  CuScreenshot,
  CuSemanticAction,
} from '@maka/runtime/computer-use-types';
import { abortableDelay } from './abortable-delay.js';
import { exceedsFrameCap } from './frame-budget.js';

export const CUA_DRIVER_VERSION = '0.34.0';
async function loadDriver(): Promise<CuaDriverPort> {
  // FFI opens a dylib itself: Electron's automatic .node extraction is insufficient.
  const entry = import.meta.resolve('@trycua/cua-driver');
  const sdk = await import(entry.replace(/\.asar\//, '.asar.unpacked/'));
  return sdk.CuaDriver.create(undefined) as CuaDriverPort;
}
export interface CuaDriverPort {
  metadata(): Promise<{ driverVersion: string }>;
  callTool(
    name: string,
    argumentsJson: string,
  ): Promise<{
    isError: boolean;
    structuredJson?: string;
    images: Array<{ dataBase64: string; mimeType: string }>;
  }>;
  shutdown(): Promise<void>;
  uniffiDestroy(): void;
}
export interface CuaDriverState {
  state: 'idle' | 'starting' | 'ready' | 'unavailable' | 'disposed';
  error?: string;
  environmentReady?: boolean;
}
export interface CuaDriverBackendOptions {
  platform?: NodeJS.Platform;
  createDriver?: () => Promise<CuaDriverPort>;
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  foregroundAuthorized?: (
    context: Pick<CuRunContext, 'sessionId' | 'turnId' | 'toolCallId'>,
  ) => boolean;
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  requestAccessibilityPermission?: (signal: AbortSignal) => Promise<void>;
  /** Desktop-owned window discovery, with native ownership checked for this exact PID. */
  listOwnedWindows?: (
    pid: number,
  ) => readonly CuaOwnedWindow[] | Promise<readonly CuaOwnedWindow[]>;
  onSessionInvalidated?: (input: { sessionId: string; outcomeUnknown: boolean }) => void;
  presentationTargetIdentity?: {
    acquire(
      target: { pid: number; windowId: number },
      context: { sessionId: string },
    ): string | undefined;
    validate(leaseId: string, target: { pid: number; windowId: number }): boolean;
    /** Validates the retained window and requires it to be foreground without activating it. */
    validateForeground?(leaseId: string, target: { pid: number; windowId: number }): boolean;
    release(leaseId: string): void;
  };
  onTrace?: (event: { type: string; tool?: string; code?: string }) => void;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
}
export interface CuaOwnedWindow {
  pid: number;
  windowId: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  role: 'AXWindow' | 'AXSheet' | 'window' | 'dialog';
}
type Json = Record<string, unknown>;
type Session = { label: string; started: boolean; observation?: CuObservation };
class DriverFailure extends Error {
  constructor(readonly code: ComputerUseErrorCode) {
    super(code);
  }
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DriverFailure('service_mismatch');
  return value as Json;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DriverFailure('service_mismatch');
  return value;
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new DriverFailure('service_mismatch');
  return value;
}
function failure(code: ComputerUseErrorCode, noInput = true): CuRunResult {
  return {
    outcome: {
      ok: false,
      error: code,
      message: code,
      messageIsAppTextFree: true,
      ...(noInput ? { evidence: { path: 'none' } } : {}),
    },
  };
}
function refusalCode(data: Json): ComputerUseErrorCode {
  const code =
    string(data.code) ??
    string(data.refusal) ??
    string((data.error as Json | undefined)?.code) ??
    '';
  if (/permission|authorization|bounded|policy/.test(code)) return 'policy_denied';
  if (/stale|snapshot|token/.test(code)) return 'stale_frame';
  if (/target|window|process/.test(code)) return 'target_changed';
  if (/background|unsupported|unavailable/.test(code)) return 'unsupported_action';
  return 'dispatch_refused';
}

/** One Desktop-owned runtime. Native calls remain queued until they actually settle,
 * even when the caller stops waiting; aborting an FFI promise does not prove input stopped. */
export function createCuaDriverBackend(options: CuaDriverBackendOptions = {}): CuDispatchBackend & {
  dispose(): Promise<void>;
  executorState(): CuaDriverState;
} {
  const platform = options.platform ?? process.platform;
  const supportedForegroundActions = [
    'click_element',
    'double_click_element',
    'press_key',
    'type',
    'scroll_element',
    ...(platform === 'linux' ? [] : ['secondary_action']),
    ...(platform === 'darwin' ? [] : ['set_value']),
  ];
  const foregroundAuthorized = (context: CuRunContext) =>
    context.foregroundAuthorized === true && (options.foregroundAuthorized?.(context) ?? true);
  let state: CuaDriverState = { state: 'idle' };
  let linuxWayland = false;
  let driverPromise: Promise<CuaDriverPort> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const sessions = new Map<string, Session>();
  // The model receives the image, not authority to invent capture identifiers.
  // Keep the native PNG proof with the exact observation which produced it.
  const pixelCaptures = new WeakMap<CuObservation, { width: number; height: number }>();
  const driver = () =>
    (driverPromise ??= (async () => {
      state = { state: 'starting' };
      try {
        const native = await (options.createDriver?.() ?? loadDriver());
        try {
          if ((await native.metadata()).driverVersion !== CUA_DRIVER_VERSION)
            throw new DriverFailure('service_mismatch');
        } catch (error) {
          try {
            await native.shutdown();
          } finally {
            native.uniffiDestroy();
          }
          throw error;
        }
        state = { state: 'ready' };
        return native;
      } catch {
        state = { state: 'unavailable', error: 'Cua Driver failed to load or version mismatched' };
        throw new DriverFailure('service_unavailable');
      }
    })());
  function enqueue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const next = queue.then(async () => {
      signal.throwIfAborted();
      if (disposed) throw new DriverFailure('service_unavailable');
      return operation();
    });
    queue = next.catch(() => undefined);
    return next;
  }
  async function call(tool: string, args: Json, beforeDispatch?: () => void) {
    const native = await driver();
    beforeDispatch?.();
    const result = await native.callTool(tool, JSON.stringify(args));
    const data = result.structuredJson ? object(JSON.parse(result.structuredJson)) : {};
    options.onTrace?.({
      type: 'driver_result',
      tool,
      ...(result.isError ? { code: refusalCode(data) } : {}),
    });
    return { ...result, data };
  }
  async function checked(tool: string, args: Json) {
    const result = await call(tool, args);
    if (result.isError) throw new DriverFailure(refusalCode(result.data));
    return result;
  }
  function reserveSession(id: string, signal: AbortSignal): Session {
    signal.throwIfAborted();
    if (disposed) throw new DriverFailure('service_unavailable');
    let value = sessions.get(id);
    if (!value) {
      if (sessions.size >= 128) throw new DriverFailure('service_unavailable');
      value = { label: `maka-${randomUUID()}`, started: false };
      sessions.set(id, value);
    }
    return value;
  }
  async function startSession(id: string, current: Session, signal: AbortSignal): Promise<void> {
    if (disposed || sessions.get(id) !== current) throw new DriverFailure('aborted');
    if (!current.started) {
      try {
        const result = await call('start_session', { session: current.label }, () => {
          signal.throwIfAborted();
          if (disposed || sessions.get(id) !== current) throw new DriverFailure('aborted');
          // A clear during the native call must enqueue cleanup even before it settles.
          current.started = true;
        });
        if (result.isError) throw new DriverFailure(refusalCode(result.data));
      } catch (error) {
        if (sessions.get(id) === current) sessions.delete(id);
        throw error;
      }
      if (disposed || sessions.get(id) !== current) throw new DriverFailure('aborted');
    }
  }
  async function listedWindows(pid?: number, ownerPids: readonly number[] = []): Promise<Json[]> {
    const result = await checked('list_windows', pid === undefined ? {} : { pid });
    const windows = array(result.data.windows)
      .map(object)
      .filter((window) => pid === undefined || window.pid === pid);
    if (!['darwin', 'win32'].includes(platform) || !options.listOwnedWindows) return windows;
    const pids = new Set(
      pid === undefined ? [...ownerPids, ...windows.map((window) => integer(window.pid))] : [pid],
    );
    for (const ownerPid of pids) {
      const owned = await options.listOwnedWindows(ownerPid);
      if (!Array.isArray(owned) || owned.length > 128) throw new DriverFailure('service_mismatch');
      for (const candidate of owned) {
        if (
          !candidate ||
          candidate.pid !== ownerPid ||
          !Number.isSafeInteger(candidate.windowId) ||
          candidate.windowId <= 0 ||
          typeof candidate.title !== 'string' ||
          !['AXWindow', 'AXSheet', 'window', 'dialog'].includes(candidate.role) ||
          ![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite) ||
          candidate.width <= 0 ||
          candidate.height <= 0
        )
          throw new DriverFailure('service_mismatch');
        if (
          windows.some(
            (window) => window.pid === ownerPid && window.window_id === candidate.windowId,
          )
        )
          continue;
        // Owned dialogs can be omitted by the SDK's main-window listing.
        // This proves ownership, but not visibility or the current Space.
        windows.push({
          pid: ownerPid,
          window_id: candidate.windowId,
          title: candidate.title,
          bounds: {
            x: candidate.x,
            y: candidate.y,
            width: candidate.width,
            height: candidate.height,
          },
        });
      }
    }
    return windows;
  }
  async function apps(): Promise<CuAppSummary[]> {
    const listed = await checked('list_apps', {});
    const running = array(listed.data.apps)
      .map(object)
      .filter((app) => app.running === true);
    const windows = await listedWindows(
      undefined,
      running.map((app) => integer(app.pid)),
    );
    return running.map((a) => {
      const pid = integer(a.pid);
      const owned = windows
        .filter((w) => w.pid === pid)
        .map((w) => ({ windowId: integer(w.window_id), title: string(w.title) }));
      return {
        appId: string(a.bundle_id) ?? string(a.name) ?? String(pid),
        pid,
        name: string(a.name),
        windowCount: owned.length,
        windows: owned,
      };
    });
  }
  async function resolveTarget(input: { app?: string; windowId?: number }) {
    // Accessory apps and unbundled test/native apps may have windows but no list_apps row.
    if (input.windowId !== undefined || (input.app && /^\d+$/.test(input.app))) {
      const pid = input.app && /^\d+$/.test(input.app) ? integer(Number(input.app)) : undefined;
      const matches = (await listedWindows(pid)).filter(
        (w) => input.windowId === undefined || w.window_id === input.windowId,
      );
      if (matches.length !== 1)
        throw new DriverFailure(matches.length ? 'ambiguous_target' : 'target_missing');
      const window = matches[0];
      const name = string(window.app_name) ?? String(window.pid);
      if (input.app && pid === undefined) {
        const owners = await apps();
        if (!owners.some((a) => a.pid === window.pid && [a.appId, a.name].includes(input.app)))
          throw new DriverFailure('target_mismatch');
      }
      return {
        app: { appId: name, pid: integer(window.pid), name, windowCount: 1 },
        windowId: integer(window.window_id),
      };
    }
    const all = await apps();
    let matches = all;
    if (input.app)
      matches = all.filter((a) =>
        [a.appId, a.name, String(a.pid)].some(
          (v) => v?.toLocaleLowerCase() === input.app!.toLocaleLowerCase(),
        ),
      );
    if (input.windowId !== undefined)
      matches = matches.filter((a) => a.windows?.some((w) => w.windowId === input.windowId));
    if (matches.length !== 1)
      throw new DriverFailure(matches.length ? 'ambiguous_target' : 'target_missing');
    const app = matches[0];
    const windows = app.windows!.filter(
      (w) => input.windowId === undefined || w.windowId === input.windowId,
    );
    if (windows.length !== 1)
      throw new DriverFailure(windows.length ? 'ambiguous_target' : 'target_missing');
    return { app, windowId: windows[0].windowId };
  }
  function screenshot(result: Awaited<ReturnType<typeof call>>): CuScreenshot | undefined {
    const image = result.images[0];
    if (!image) return undefined;
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg')
      throw new DriverFailure('service_mismatch');
    const encoded = options.compressFrame?.(image.dataBase64, image.mimeType) ?? {
      base64: image.dataBase64,
      mimeType: image.mimeType,
    };
    if (exceedsFrameCap(Buffer.byteLength(encoded.base64, 'base64')))
      throw new DriverFailure('capture_failed');
    return {
      ...encoded,
      widthPx: integer(result.data.screenshot_width),
      heightPx: integer(result.data.screenshot_height),
    };
  }
  function pixelCapture(result: Awaited<ReturnType<typeof call>>) {
    const image = result.images[0];
    const data = result.data;
    if (
      image?.mimeType !== 'image/png' ||
      !string(data.capture_id) ||
      data.screenshot_frame_valid === false
    )
      return undefined;
    const png = Buffer.from(image.dataBase64, 'base64');
    if (
      png.length < 33 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR'
    )
      return undefined;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width !== data.screenshot_width ||
      height !== data.screenshot_height ||
      (data.screenshot_original_width !== undefined && data.screenshot_original_width !== width) ||
      (data.screenshot_original_height !== undefined && data.screenshot_original_height !== height)
    )
      return undefined;
    return { width, height };
  }
  async function capture(
    target: { app: CuAppSummary; windowId: number },
    input: { includeScreenshot: boolean; query?: string },
    context: CuRunContext,
    current: Session,
    signal: AbortSignal,
  ) {
    if (await options.screenLocked?.(context)) throw new DriverFailure('screen_locked');
    signal.throwIfAborted();
    if (disposed || sessions.get(context.sessionId) !== current) throw new DriverFailure('aborted');
    const presentationTarget = { pid: target.app.pid, windowId: target.windowId };
    let presentationLease: string | undefined;
    try {
      presentationLease = options.presentationTargetIdentity?.acquire(presentationTarget, context);
    } catch {
      /* Optional preview identity cannot refuse a truthful execution observation. */
    }
    try {
      const readPresentationGeometry = async () => {
        try {
          const matches = (await listedWindows(target.app.pid)).filter(
            (w) => w.pid === target.app.pid && w.window_id === target.windowId,
          );
          if (matches.length !== 1) return undefined;
          const window = matches[0];
          const bounds = window.bounds ? object(window.bounds) : undefined;
          if (
            !bounds ||
            !['x', 'y', 'width', 'height'].every(
              (key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]),
            ) ||
            Number(bounds.width) <= 0 ||
            Number(bounds.height) <= 0
          )
            return undefined;
          return {
            bounds,
            visible:
              window.is_on_screen === true &&
              window.minimized !== true &&
              (platform !== 'darwin' || window.on_current_space === true),
          };
        } catch {
          return undefined;
        }
      };
      // Bracket AX-only geometry with read-only metadata. Later window bounds
      // cannot safely be mixed with the earlier absolute AX element frames.
      const beforeGeometry = await readPresentationGeometry();
      signal.throwIfAborted();
      if (disposed || sessions.get(context.sessionId) !== current)
        throw new DriverFailure('aborted');
      const result = await checked('get_window_state', {
        session: current.label,
        pid: target.app.pid,
        window_id: target.windowId,
        include_accessibility_tree: true,
        include_screenshot: input.includeScreenshot,
        ...(input.query ? { query: input.query } : {}),
      });
      const data = result.data;
      if (integer(data.pid) !== target.app.pid || integer(data.window_id) !== target.windowId)
        throw new DriverFailure('target_mismatch');
      const frame = screenshot(result);
      const accessibilityUnavailable = data.degraded === true;
      if (
        accessibilityUnavailable &&
        (!frame ||
          !input.includeScreenshot ||
          !/^(ax_tree_empty|atspi_tree_empty|msaa_fallback_partial):/.test(
            string(data.degraded_reason) ?? '',
          ))
      )
        throw new DriverFailure('capture_failed');
      // Empty walks and partial MSAA trees do not invalidate exact-window pixels,
      // but their element tokens are not authoritative. Other degraded identity/route
      // failures remain closed rather than admitting application-scoped content.
      const rows = accessibilityUnavailable ? [] : array(data.elements ?? []).map(object);
      const ids = new Map(
        rows
          .filter((e) => string(e.element_token))
          .map((e) => [integer(e.element_index), string(e.element_token)!]),
      );
      let bounds = data.window_bounds ? object(data.window_bounds) : undefined;
      let presentationVisibility: CuObservation['presentationVisibility'] = 'unavailable';
      signal.throwIfAborted();
      if (disposed || sessions.get(context.sessionId) !== current)
        throw new DriverFailure('aborted');
      const afterGeometry = await readPresentationGeometry();
      const equalBounds = (left: Json, right: Json) =>
        ['x', 'y', 'width', 'height'].every((key) => left[key] === right[key]);
      if (
        !bounds &&
        beforeGeometry &&
        afterGeometry &&
        equalBounds(beforeGeometry.bounds, afterGeometry.bounds) &&
        beforeGeometry.visible === afterGeometry.visible
      ) {
        bounds = beforeGeometry.bounds;
      }
      if (
        bounds &&
        beforeGeometry?.visible &&
        afterGeometry?.visible &&
        equalBounds(bounds, beforeGeometry.bounds) &&
        equalBounds(bounds, afterGeometry.bounds)
      ) {
        presentationVisibility = 'visible';
      }
      const observation: CuObservation = {
        observationId: randomUUID(),
        appId: target.app.appId,
        appName: target.app.name,
        pid: target.app.pid,
        windowId: target.windowId,
        windowTitle: string(data.window_title),
        capturedAt: Date.now(),
        presentationVisibility,
        query: input.query,
        accessibilityText: accessibilityUnavailable
          ? undefined
          : string(data.tree_markdown)?.slice(0, 100_000),
        ...(accessibilityUnavailable ? { accessibilityUnavailable: true } : {}),
        truncated:
          data.truncated === true ||
          data.elements_complete === false ||
          (string(data.tree_markdown)?.length ?? 0) > 100_000,
        ...(bounds
          ? {
              windowBounds: {
                x: Number(bounds.x),
                y: Number(bounds.y),
                width: Number(bounds.width),
                height: Number(bounds.height),
              },
            }
          : {}),
        elements: rows
          .filter((e) => string(e.element_token))
          .map((e) => ({
            elementId: string(e.element_token)!,
            role: (string(e.role) ?? 'unknown').replace(/\s+/g, '_'),
            label: string(e.label),
            value: string(e.value),
            enabled: typeof e.enabled === 'boolean' ? e.enabled : undefined,
            selected: typeof e.selected === 'boolean' ? e.selected : undefined,
            parentElementId: e.parent_index == null ? undefined : ids.get(integer(e.parent_index)),
            actions: (Array.isArray(e.actions)
              ? e.actions.filter((a): a is string => typeof a === 'string')
              : []
            )
              .map((a) =>
                a
                  .replace(/^AX/, '')
                  .replace(/([a-z])([A-Z])/g, '$1_$2')
                  .toLowerCase(),
              )
              .filter((a) =>
                (platform === 'darwin'
                  ? ['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open']
                  : platform === 'win32'
                    ? ['expand']
                    : []
                ).includes(a),
              ),
            ...(e.frame
              ? {
                  frame: {
                    x: Number(object(e.frame).x),
                    y: Number(object(e.frame).y),
                    width: Number(object(e.frame).w),
                    height: Number(object(e.frame).h),
                  },
                }
              : {}),
            identity: {
              token: string(e.element_token),
              role: (string(e.role) ?? 'unknown').replace(/\s+/g, '_'),
              label: string(e.label),
              value: string(e.value),
            },
          })),
        screenshot: frame,
      };
      // Cua supersedes tokens when another task observes the same window.
      for (const [id, other] of sessions) {
        if (
          other.observation?.pid === observation.pid &&
          other.observation.windowId === observation.windowId
        ) {
          other.observation = undefined;
          if (id !== context.sessionId)
            options.onSessionInvalidated?.({ sessionId: id, outcomeUnknown: false });
        }
      }
      signal.throwIfAborted();
      if (disposed || sessions.get(context.sessionId) !== current)
        throw new DriverFailure('aborted');
      if (await options.screenLocked?.(context)) throw new DriverFailure('screen_locked');
      signal.throwIfAborted();
      if (disposed || sessions.get(context.sessionId) !== current)
        throw new DriverFailure('aborted');
      if (presentationLease) {
        try {
          if (options.presentationTargetIdentity?.validate(presentationLease, presentationTarget)) {
            observation.presentationTargetLease = presentationLease;
            presentationLease = undefined;
          }
        } catch {
          /* A lost retained window suppresses preview, not execution. */
        }
      }
      current.observation = observation;
      const pixels = input.includeScreenshot && pixelCapture(result);
      if (pixels) pixelCaptures.set(observation, pixels);
      return observation;
    } finally {
      if (presentationLease) {
        try {
          options.presentationTargetIdentity?.release(presentationLease);
        } catch {}
      }
    }
  }
  async function observe(
    input: {
      app?: string;
      windowId?: number;
      includeScreenshot: boolean;
      query?: string;
      menu?: string;
    },
    signal: AbortSignal,
    context: CuRunContext,
  ) {
    if (input.menu !== undefined) throw new DriverFailure('unsupported_action');
    // Reserve before queueing: clearing a task also retires its not-yet-started work.
    const current = reserveSession(context.sessionId, signal);
    return enqueue(signal, async () => {
      await startSession(context.sessionId, current, signal);
      const target = await resolveTarget(input);
      const result = await capture(target, input, context, current, signal);
      signal.throwIfAborted();
      return { ...result, appAlias: input.app };
    });
  }
  function actionOutcome(
    result: Awaited<ReturnType<typeof call>>,
    requestedDelivery: 'background' | 'foreground',
    tool: string,
  ): CuRunResult {
    const data = result.data;
    // 0.34.0 Linux DoubleClickTool's background gates and uinput creation errors
    // precede target input; their background_unavailable builder omits effect.
    // Other input errors and legacy Mac reports can follow dispatched input.
    const legacyBackgroundRefusal =
      platform === 'linux' &&
      tool === 'double_click' &&
      requestedDelivery === 'background' &&
      result.isError &&
      data.code === 'background_unavailable' &&
      data.effect === undefined &&
      data.route === undefined &&
      data.delivery === undefined &&
      (data.escalation as Json | undefined)?.recommended === 'foreground';
    if (data.effect === 'refused' || legacyBackgroundRefusal) {
      const refused = failure(refusalCode(data));
      refused.outcome.evidence = { ...refused.outcome.evidence, requestedDelivery };
      if (
        !refused.outcome.ok &&
        (data.code === 'background_unavailable' || data.refusal === 'background_unavailable')
      ) {
        refused.outcome.message =
          'Background input is unavailable for this target. Foreground delivery requires current-task authorization.';
      }
      return refused;
    }
    const route = string(data.route);
    const delivery = data.delivery ? string(object(data.delivery).mode) : undefined;
    const actualDelivery =
      delivery === 'background' || delivery === 'foreground' || delivery === 'not_applicable'
        ? delivery
        : undefined;
    const unknown = () => {
      const result = failure('outcome_unknown', false);
      result.outcome.evidence = {
        requestedDelivery,
        ...(actualDelivery ? { actualDelivery, reason: `delivery:${actualDelivery}` } : {}),
      };
      return result;
    };
    if (result.isError) return unknown();
    // Unknown/partial results remain failures, with no claim that zero input was sent.
    if (
      !['confirmed', 'unverifiable', 'suspected_noop'].includes(String(data.effect)) ||
      ![
        'accessibility',
        'system_api',
        'synthetic_events',
        'global_input',
        'trusted_input',
      ].includes(route ?? '') ||
      (delivery !== undefined &&
        !['background', 'foreground', 'not_applicable'].includes(delivery)) ||
      (delivery === 'foreground' && requestedDelivery !== 'foreground') ||
      (route !== 'accessibility' &&
        route !== 'system_api' &&
        delivery !== 'background' &&
        delivery !== 'foreground')
    )
      return unknown();
    const path =
      route === 'accessibility'
        ? 'ax'
        : route === 'system_api'
          ? 'system-api'
          : delivery === 'foreground'
            ? 'foreground-input'
            : 'background-input';
    return {
      outcome: {
        ok: true,
        tier:
          delivery === 'foreground'
            ? 'semantic-foreground'
            : route === 'accessibility'
              ? 'ax'
              : 'semantic-background',
        verified: data.effect === 'confirmed',
        evidence: {
          path,
          effect: data.effect as 'confirmed' | 'unverifiable' | 'suspected_noop',
          reason: delivery ? `delivery:${delivery}` : 'delivery:unknown',
          requestedDelivery,
          ...(delivery
            ? { actualDelivery: delivery as 'background' | 'foreground' | 'not_applicable' }
            : {}),
        },
      },
    };
  }
  async function runSemantic(
    action: CuSemanticAction,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult> {
    let dispatched = false;
    const requestedDelivery = action.delivery ?? 'background';
    try {
      return await enqueue(signal, async () => {
        if (requestedDelivery !== 'background' && requestedDelivery !== 'foreground')
          return failure('unsupported_action');
        if (requestedDelivery === 'foreground') {
          if (!supportedForegroundActions.includes(action.type))
            return failure('unsupported_action');
          if (!foregroundAuthorized(context)) return failure('policy_denied');
        }
        const current = sessions.get(context.sessionId);
        const observed = current?.observation;
        if (!current || !observed || observed.observationId !== action.observationId)
          return failure('stale_frame');
        const element = action.elementId
          ? observed.elements.find((e) => e.elementId === action.elementId)
          : undefined;
        if (action.elementId && !element) return failure('target_missing');
        if (action.elementIdentity && action.elementIdentity.token !== element?.identity?.token)
          return failure('target_mismatch');
        if (element?.enabled === false) return failure('dispatch_refused');
        const common = { session: current.label, pid: observed.pid, window_id: observed.windowId };
        const coordinate = 'coordinate' in action ? action.coordinate : undefined;
        const preserveFocus = 'focus' in action && action.focus === 'current';
        const focusTargetFailure = (): ComputerUseErrorCode | undefined => {
          try {
            const identity = options.presentationTargetIdentity;
            const lease = observed.presentationTargetLease;
            const target = { pid: observed.pid, windowId: observed.windowId };
            if (lease && identity?.validate(lease, target)) {
              if (!identity.validateForeground) return 'unsupported_action';
              if (identity.validateForeground(lease, target)) return undefined;
            }
          } catch {}
          // Lost identity or focus invalidates the selection and its public frame.
          // Zero dispatched input does not prove that the old window still exists.
          current.observation = undefined;
          options.onSessionInvalidated?.({ sessionId: context.sessionId, outcomeUnknown: false });
          return 'target_changed';
        };
        if (preserveFocus) {
          if (
            !['type', 'press_key'].includes(action.type) ||
            platform !== 'win32' ||
            requestedDelivery !== 'foreground'
          )
            return failure('unsupported_action');
          if (action.elementId !== undefined || coordinate !== undefined)
            return failure('target_mismatch');
          if (!pixelCaptures.has(observed)) return failure('capture_failed');
          const focusFailure = focusTargetFailure();
          if (focusFailure) return failure(focusFailure);
        }
        if (coordinate !== undefined) {
          if (!['type', 'press_key'].includes(action.type) || action.elementId)
            return failure('invalid_coordinate');
          const pixels = pixelCaptures.get(observed);
          if (!pixels) return failure('capture_failed');
          if (
            !Array.isArray(coordinate) ||
            coordinate.length !== 2 ||
            !coordinate.every(Number.isSafeInteger) ||
            coordinate[0] < 0 ||
            coordinate[0] >= pixels.width ||
            coordinate[1] < 0 ||
            coordinate[1] >= pixels.height
          )
            return failure('invalid_coordinate');
        }
        const bound = {
          ...common,
          ...(element ? { element_token: element.elementId } : {}),
          ...(coordinate ? { x: coordinate[0], y: coordinate[1] } : {}),
        };
        let tool: string;
        let args: Json;
        switch (action.type) {
          case 'click_element':
          case 'double_click_element':
            tool = action.type === 'double_click_element' ? 'double_click' : 'click';
            args = { ...bound, delivery_mode: requestedDelivery };
            break;
          case 'set_value':
            tool = 'set_value';
            args = {
              ...bound,
              value: action.value,
              ...(platform === 'darwin' ? {} : { delivery_mode: requestedDelivery }),
            };
            break;
          case 'type':
            // The callTool contract accepts a snapshot token even though the
            // generated TypeTextInput record omits that platform-specific field.
            if (!element && !coordinate && !preserveFocus) return failure('target_missing');
            tool = 'type_text';
            args = { ...bound, text: action.text, delivery_mode: requestedDelivery };
            break;
          case 'press_key':
            // Omit element/pixel focus only for the explicit, retained-window route.
            // Re-clicking a pixel here would discard a selection from Ctrl+A.
            if (!element && !coordinate && !preserveFocus) return failure('target_missing');
            {
              const parts = action.key.split('+');
              const key = parts.pop();
              if (
                !key ||
                parts.some(
                  (p) =>
                    ![
                      'cmd',
                      'command',
                      'ctrl',
                      'control',
                      'shift',
                      'alt',
                      'option',
                      'meta',
                      'super',
                      'win',
                    ].includes(p.toLowerCase()),
                )
              )
                return failure('unsupported_action');
              tool = 'press_key';
              args = {
                ...bound,
                key,
                modifiers: parts.map((p) => {
                  const modifier = p.toLowerCase();
                  if (modifier === 'control') return 'ctrl';
                  if (modifier === 'option') return 'alt';
                  if (modifier === 'shift' || modifier === 'ctrl' || modifier === 'alt')
                    return modifier;
                  return platform === 'darwin' ? 'cmd' : platform === 'win32' ? 'win' : 'super';
                }),
                delivery_mode: requestedDelivery,
              };
              break;
            }
          case 'scroll_element':
            if (
              !Number.isInteger(action.pages ?? 1) ||
              (action.pages ?? 1) < 1 ||
              (action.pages ?? 1) > 50
            )
              return failure('unsupported_action');
            tool = 'scroll';
            args = {
              ...bound,
              direction: action.direction,
              by: 'page',
              amount: action.pages ?? 1,
              delivery_mode: requestedDelivery,
            };
            break;
          case 'secondary_action':
            if (!element?.actions?.includes(action.action)) return failure('unsupported_action');
            tool = 'click';
            args = { ...bound, action: action.action, delivery_mode: requestedDelivery };
            break;
          case 'window_action': {
            if (platform === 'linux' && linuxWayland) {
              const result = failure('unsupported_action');
              if (!result.outcome.ok) {
                result.outcome.message =
                  'Moving or resizing windows requires X11; this native Wayland session does not support window geometry changes.';
              }
              return result;
            }
            if (action.action === 'minimize' || !observed.windowBounds)
              return failure('unsupported_action');
            const frame = observed.windowBounds;
            tool = 'set_window_frame';
            args = {
              ...common,
              x: action.position?.x ?? frame.x,
              y: action.position?.y ?? frame.y,
              width: action.size?.width ?? frame.width,
              height: action.size?.height ?? frame.height,
            };
            break;
          }
          default:
            return failure('unsupported_action');
        }
        // Global idle is only a foreground collision hint, not input attribution.
        if (requestedDelivery === 'foreground' && (await options.physicalInputRecentlyActive?.()))
          return failure('user_intervened');
        if (await options.screenLocked?.(context)) return failure('screen_locked');
        signal.throwIfAborted();
        if (sessions.get(context.sessionId) !== current || current.observation !== observed)
          return failure('stale_frame');
        await context.beforeNativeDispatch?.();
        // Presentation can yield while the user locks, intervenes, or revokes the task.
        if (requestedDelivery === 'foreground' && (await options.physicalInputRecentlyActive?.()))
          return failure('user_intervened');
        if (await options.screenLocked?.(context)) return failure('screen_locked');
        const native = await call(tool, args, () => {
          signal.throwIfAborted();
          if (requestedDelivery === 'foreground' && !foregroundAuthorized(context))
            throw new DriverFailure('policy_denied');
          if (
            disposed ||
            sessions.get(context.sessionId) !== current ||
            current.observation !== observed
          )
            throw new DriverFailure('stale_frame');
          if (preserveFocus) {
            const focusFailure = focusTargetFailure();
            if (focusFailure) throw new DriverFailure(focusFailure);
          }
          current.observation = undefined;
          dispatched = true;
        });
        if (signal.aborted || sessions.get(context.sessionId) !== current)
          return failure('outcome_unknown', false);
        const result = actionOutcome(native, requestedDelivery, tool);
        if (!result.outcome.ok) {
          if (result.outcome.evidence?.path === 'none') {
            if (['target_changed', 'stale_frame'].includes(result.outcome.error)) {
              // The SDK refused before input because its bound target or token expired.
              // A failed refresh must not leave that frame available for another action.
              options.onSessionInvalidated?.({
                sessionId: context.sessionId,
                outcomeUnknown: false,
              });
            } else {
              current.observation = observed;
            }
          }
          return result;
        }
        try {
          result.observation = await capture(
            {
              app: { appId: observed.appId, pid: observed.pid, windowCount: 1 },
              windowId: observed.windowId,
            },
            { includeScreenshot: Boolean(observed.screenshot) },
            context,
            current,
            signal,
          );
          result.screenshot = result.observation.screenshot;
        } catch {
          // Runtime consumes this action's frame when it receives the result. Invalidating
          // it here would replace the dispatched outcome with a stale-lease refusal.
        }
        if (signal.aborted) return failure('outcome_unknown', false);
        return result;
      });
    } catch (error) {
      return failure(
        dispatched
          ? 'outcome_unknown'
          : signal.aborted
            ? 'aborted'
            : error instanceof DriverFailure
              ? error.code
              : 'service_unavailable',
        !dispatched,
      );
    }
  }
  return {
    supportedForegroundActions,
    supportedActions: [
      'list_apps',
      ...(platform === 'darwin' ? ['launch_app'] : []),
      'observe',
      'screenshot',
      'wait',
      'click_element',
      'double_click_element',
      'set_value',
      'type',
      'press_key',
      'scroll_element',
      ...(platform === 'linux' ? [] : ['secondary_action']),
      'window_action',
      'element_sequence',
    ],
    supportedWindowActions: ['move', 'resize'],
    preflight: (signal) =>
      enqueue(signal, async () => {
        const { data } = await checked(
          'check_permissions',
          platform === 'darwin' ? { prompt: false } : {},
        );
        if (platform === 'linux') {
          // Wayland availability does not grant a portal session or prove any particular route.
          linuxWayland = data.wayland === true && data.wayland_enabled === true;
          const display = data.x11 === true || linuxWayland;
          state.environmentReady = display && data.atspi === true;
          return {
            accessibility: state.environmentReady,
            screenRecording: display,
            ...(!state.environmentReady
              ? {
                  accessibilityGuidance: display
                    ? 'Linux accessibility is unavailable. Enable toolkit accessibility and AT-SPI on the graphical user session bus; run Maka as that desktop user.'
                    : 'Linux desktop access is unavailable. Connect a supported X11 or enabled Wayland session.',
                }
              : {}),
            ...(!display
              ? {
                  screenRecordingGuidance:
                    'Screen capture requires a supported Linux display session; Wayland also requires compositor and portal support.',
                }
              : {}),
          };
        }
        if (platform === 'win32') {
          // UIA is not gated by macOS TCC. UIPI and secure desktop restrictions remain per-target.
          state.environmentReady = data.uia === true;
          return {
            accessibility: data.uia === true,
            screenRecording: true,
            ...(data.uia !== true
              ? {
                  accessibilityGuidance:
                    'Windows UI Automation is unavailable in the controlled desktop session. Check the session and target integrity level.',
                }
              : {}),
          };
        }
        state.environmentReady = data.accessibility === true;
        return {
          accessibility: data.accessibility === true,
          screenRecording: data.screen_recording === true,
          ...(data.accessibility !== true
            ? {
                accessibilityGuidance:
                  'Allow Maka in System Settings → Privacy & Security → Accessibility, then fully quit and reopen Maka.',
              }
            : {}),
          ...(data.screen_recording !== true
            ? {
                screenRecordingGuidance:
                  'Screenshots require Maka in System Settings → Privacy & Security → Screen Recording. After changing the grant, fully quit and reopen Maka. Element-only operations can continue without screenshots.',
              }
            : {}),
        };
      }),
    requestAccessibilityPermission:
      platform === 'darwin' ? options.requestAccessibilityPermission : undefined,
    listApps: (signal) => enqueue(signal, apps),
    observeApp: observe,
    captureObservation: observe,
    runSemantic,
    launchApp: async (input, signal, context) => {
      // Windows/Linux launch identifiers and foreground effects are not yet qualified here.
      if (platform !== 'darwin') throw new DriverFailure('unsupported_action');
      const current = reserveSession(context.sessionId, signal);
      return enqueue(signal, async () => {
        await startSession(context.sessionId, current, signal);
        if (await options.screenLocked?.(context)) throw new DriverFailure('screen_locked');
        signal.throwIfAborted();
        if (disposed || sessions.get(context.sessionId) !== current)
          throw new DriverFailure('aborted');
        let dispatched = false;
        let launched;
        try {
          launched = await call('launch_app', { session: current.label, name: input.app }, () => {
            signal.throwIfAborted();
            if (disposed || sessions.get(context.sessionId) !== current)
              throw new DriverFailure('aborted');
            dispatched = true;
          });
        } catch (error) {
          if (dispatched) throw new DriverFailure('outcome_unknown');
          throw error;
        }
        if (signal.aborted || disposed || sessions.get(context.sessionId) !== current)
          throw new DriverFailure('outcome_unknown');
        if (launched.isError) throw new DriverFailure(refusalCode(launched.data));
        const { data } = launched;
        if (data.self_activation_suppressed === false) throw new DriverFailure('outcome_unknown');
        return {
          pid: integer(data.pid),
          bundleId: string(data.bundle_id),
          name: string(data.name),
          windows: array(data.windows ?? [])
            .map(object)
            .map((w) => ({ windowId: integer(w.window_id), title: string(w.title) })),
          focusHeld:
            typeof data.self_activation_suppressed === 'boolean'
              ? data.self_activation_suppressed
              : undefined,
        };
      });
    },
    async run(action, signal) {
      if (action.type === 'wait') {
        await abortableDelay(Math.min(action.durationMs, 10000), signal);
        return { outcome: { ok: true, tier: 'ax' } };
      }
      return failure('unsupported_action');
    },
    clearSession(id) {
      const old = sessions.get(id);
      sessions.delete(id);
      if (old?.started && !disposed) {
        const end = queue.then(() => checked('end_session', { session: old.label }));
        queue = end.catch(() => {
          state = { state: 'unavailable', error: 'Session cleanup failed' };
          disposed = true;
        });
      }
    },
    executorState: () => ({ ...state }),
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      sessions.clear();
      disposal = (async () => {
        await queue;
        if (driverPromise) {
          const native = await driverPromise.catch(() => undefined);
          if (native) {
            try {
              await native.shutdown();
            } finally {
              native.uniffiDestroy();
            }
          }
        }
        state = { state: 'disposed' };
      })();
      return disposal;
    },
  };
}
