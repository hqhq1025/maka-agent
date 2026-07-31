import {
  buildComputerUseTools,
  type CuOverlayHook,
  type ComputerUseToolSet,
  type CuDispatchBackend,
} from '@maka/runtime';
import { createMakaCuBackend } from './maka-cu-backend.js';
import type { MakaCuBackendOptions } from './maka-cu-backend.js';
import type { MakaCuServiceSnapshot } from './maka-cu-service.js';

/**
 * One executor.
 *
 * This was a two-member set while cua-driver was being replaced, and the
 * selector was generic over which one a caller asked for. Keeping the id now
 * that the second executor is gone is not ceremony: `backendId` is what the
 * capability snapshot reports and what `'none'` is distinguished from, so it
 * stays a named value rather than becoming a boolean nobody can read.
 */
export const CU_BACKEND_IDS = ['maka-cu'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void;
  /** maka-cu supervises one child, not a role pair, so it reports its own shape. */
  executorState?: () => MakaCuServiceSnapshot;
};

export interface SelectedComputerUseBackend<TId extends CuBackendId = CuBackendId> {
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

const NONE: SelectedComputerUseBackend = {
  backend: undefined,
  tools: emptyTools(),
  backendId: 'none',
};

export function selectComputerUseBackend(deps?: {
  binaryPath?: string;
  expectedBinarySha256?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  screenLocked?: () => boolean | Promise<boolean>;
  /** Diagnostics only; see `CuDebugRecord`. */
  debug?: Parameters<typeof buildComputerUseTools>[0]['debug'];
  onTrace?: MakaCuBackendOptions['onTrace'];
  overlay?: CuOverlayHook;
  createBackend?: (options: MakaCuBackendOptions) => DisposableBackend;
  /**
   * Typing, scrolling and dragging synthesize input. maka.cu dispatches them
   * pid-bound rather than globally, so this is no longer the blunt "can this
   * product write anything at all" switch it was on the previous executor — but
   * it is still the line between reading a machine and posting events to it,
   * and the caller declares which side it is on.
   */
  allowCompatibilityInputDispatch?: boolean;
}): SelectedComputerUseBackend {
  if (process.platform !== 'darwin') return NONE;
  if (!deps?.binaryPath || !deps.expectedBinarySha256) return NONE;
  try {
    let tools: ComputerUseToolSet | undefined;
    const backend = (deps.createBackend ?? createMakaCuBackend)({
      binaryPath: deps.binaryPath,
      expectedBinarySha256: deps.expectedBinarySha256,
      ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
      ...(deps.physicalInputRecentlyActive
        ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
        : {}),
      ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}),
      ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
      ...(deps.allowCompatibilityInputDispatch === undefined
        ? {}
        : { allowCompatibilityInputDispatch: deps.allowCompatibilityInputDispatch }),
      onSessionInvalidated: ({ sessionId }) => {
        tools?.sessionEvents.reobserveRequired(sessionId);
      },
    });
    tools = buildComputerUseTools({
      backend,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
      ...(deps.debug ? { debug: deps.debug } : {}),
    });
    return { backend, tools, backendId: 'maka-cu' };
  } catch {
    return NONE;
  }
}
