import {
  buildComputerUseTools,
  type CuOverlayHook,
  type ComputerUseToolSet,
  type CuDispatchBackend,
} from '@maka/runtime';
import { createCuaDriverBackend } from './cua-driver-backend.js';
import type { CuaDriverBackendOptions } from './cua-driver-backend.js';
import type { CuaDriverRoleSnapshot } from './cua-driver-release.js';
import { createMakaCuBackend } from './maka-cu-backend.js';
import type { MakaCuBackendOptions } from './maka-cu-backend.js';
import type { MakaCuServiceSnapshot } from './maka-cu-service.js';

export const CU_BACKEND_IDS = ['cua-driver', 'maka-cu'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  serviceState?: () => {
    action: CuaDriverRoleSnapshot;
    capture: CuaDriverRoleSnapshot;
  };
  /** maka-cu supervises one child, not a role pair, so it reports its own shape. */
  executorState?: () => MakaCuServiceSnapshot;
};

/**
 * The selected backend, parameterised by which executor was asked for. The
 * default is `cua-driver` so an existing caller's `backendId` stays exactly as
 * narrow as it was: a host that never asks for maka-cu can never be handed it.
 */
export interface SelectedComputerUseBackend<TId extends CuBackendId = 'cua-driver'> {
  backend?: DisposableBackend;
  tools: ComputerUseToolSet;
  backendId: TId | 'none';
}

function emptyTools(): ComputerUseToolSet {
  const tools = [] as unknown as ComputerUseToolSet;
  tools.clearSession = () => {};
  const snapshot = () => ({ status: 'unobserved' as const, generation: 0 });
  tools.sessionEvents = {
    snapshot,
    physicalUserIntervened: snapshot,
    interventionDebounceElapsed: snapshot,
    reobserveRequired: snapshot,
    screenLocked: snapshot,
    screenUnlocked: snapshot,
    blockedUrlDetected: snapshot,
    userStopped: snapshot,
    dynamicContentChanged: snapshot,
  };
  return tools;
}

const NONE: SelectedComputerUseBackend<CuBackendId> = {
  backend: undefined,
  tools: emptyTools(),
  backendId: 'none',
};

function resolveHostBundleId(explicit?: string): string {
  return explicit ?? process.env.MAKA_CU_HOST_BUNDLE_ID ?? 'com.maka.desktop';
}

export function selectComputerUseBackend<TId extends CuBackendId = 'cua-driver'>(deps?: {
  /**
   * Which executor to speak to. Defaults to `cua-driver`: `maka-cu` does not
   * exist as a signed artifact yet, so it is selected explicitly or not at all —
   * nothing falls back to it, and nothing falls back off it either.
   */
  backendId?: TId;
  binaryPath?: string;
  hostBundleId?: string;
  expectedBinarySha256?: string;
  expectedServerName?: string;
  expectedServerVersion?: string;
  expectedProtocolVersion?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  screenLocked?: () => boolean | Promise<boolean>;
  onTrace?: CuaDriverBackendOptions['onTrace'];
  onMakaCuTrace?: MakaCuBackendOptions['onTrace'];
  overlay?: CuOverlayHook;
  createBackend?: (options: CuaDriverBackendOptions) => DisposableBackend;
  createMakaCuBackend?: (options: MakaCuBackendOptions) => DisposableBackend;
}): SelectedComputerUseBackend<TId> {
  if (process.platform !== 'darwin') return NONE as SelectedComputerUseBackend<TId>;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) {
    return NONE as SelectedComputerUseBackend<TId>;
  }
  const backendId = (deps.backendId ?? 'cua-driver') as TId;
  try {
    let tools: ComputerUseToolSet | undefined;
    const backend =
      backendId === 'maka-cu'
        ? (deps.createMakaCuBackend ?? createMakaCuBackend)({
            binaryPath: deps.binaryPath,
            expectedBinarySha256: deps.expectedBinarySha256,
            // `expectedProtocolVersion` is deliberately not forwarded: maka.cu/2
            // pins one protocol string with no negotiation (§2), and the
            // cua-driver MCP date string must not leak into that handshake.
            ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
            ...(deps.physicalInputRecentlyActive
              ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
              : {}),
            ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}),
            ...(deps.onMakaCuTrace ? { onTrace: deps.onMakaCuTrace } : {}),
            onSessionInvalidated: ({ sessionId }) => {
              tools?.sessionEvents.reobserveRequired(sessionId);
            },
          })
        : (deps.createBackend ?? createCuaDriverBackend)({
            binaryPath: deps.binaryPath,
            hostBundleId: resolveHostBundleId(deps?.hostBundleId),
            expectedBinarySha256: deps.expectedBinarySha256,
            ...(deps.expectedServerName ? { expectedServerName: deps.expectedServerName } : {}),
            ...(deps.expectedServerVersion
              ? { expectedServerVersion: deps.expectedServerVersion }
              : {}),
            ...(deps.expectedProtocolVersion
              ? { expectedProtocolVersion: deps.expectedProtocolVersion }
              : {}),
            ...(deps?.compressFrame ? { compressFrame: deps.compressFrame } : {}),
            ...(deps?.physicalInputRecentlyActive
              ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
              : {}),
            ...(deps?.screenLocked ? { screenLocked: deps.screenLocked } : {}),
            ...(deps?.onTrace ? { onTrace: deps.onTrace } : {}),
            // Typing, scrolling and dragging go through cua-driver's compatibility
            // event backend. That path was left off in the shipping build, which meant
            // the code existed, had tests, and could never run — Computer Use could
            // look at a machine and click on it, but not write in it, scroll it, or
            // drag anything.
            //
            // The concern behind the switch was real: synthesized events can collide
            // with what the user is physically doing. Turning off the whole capability
            // is a blunt way to express that, and the precise one is already here —
            // `physicalInputFailure()` guards every one of these dispatch sites and
            // refuses while the user is actually at the keyboard, driven by the
            // `physicalInputRecentlyActive` probe the host passes in above.
            //
            // maka-cu needs no equivalent: its dispatch path is declared, never
            // discovered, so there is no compatibility mode to switch on.
            allowCompatibilityInputDispatch: true,
            onSessionInvalidated: ({ sessionId }) => {
              tools?.sessionEvents.reobserveRequired(sessionId);
            },
          });
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
    });
    return {
      backend,
      tools,
      backendId,
    };
  } catch {
    return NONE as SelectedComputerUseBackend<TId>;
  }
}
