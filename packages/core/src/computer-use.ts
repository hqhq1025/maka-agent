/**
 * Provider-neutral Computer Use contract.
 *
 * This module contains shared vocabulary only. It does not select a provider,
 * capture a screen, or dispatch input. Runtime and host implementations must
 * preserve these identities and fail-closed semantics end to end.
 */

import { redactSecrets } from './redaction.js';

export const COMPUTER_USE_ERROR_CODES = [
  'permission_missing',
  'permission_pending',
  'policy_denied',
  'policy_forbidden',
  'invalid_coordinate',
  'capture_failed',
  'sensitivity_blocked',
  'unsupported_action',
  'aborted',
  'timeout',
  'no_active_frame',
  'no_active_session',
  'stale_frame',
  'stale_epoch',
  'target_missing',
  'ambiguous_target',
  'target_changed',
  'target_occluded',
  'page_target_changed',
  'duplicate_action',
  'user_intervened',
  'reobserve_required',
  'screen_locked',
  'blocked_url',
  'user_stopped',
  'service_unavailable',
  'service_mismatch',
  'outcome_unknown',
] as const;

export type ComputerUseErrorCode = (typeof COMPUTER_USE_ERROR_CODES)[number];

export function isComputerUseErrorCode(value: unknown): value is ComputerUseErrorCode {
  return (
    typeof value === 'string' && (COMPUTER_USE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface CuPoint {
  x: number;
  y: number;
}

export interface CuRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ComputerUseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerUseFrameIdentity {
  frameId: string;
  epoch: number;
}

export interface ComputerUseDisplayIdentity {
  displayId: string;
  logicalBounds: ComputerUseRect;
  sourceBoundsPx: ComputerUseRect;
  scaleFactor: number;
}

export interface ComputerUsePageIdentity {
  cdpPort: number;
  pageTargetId: string;
  pageUrl: string;
  targetUrlContains: string;
  documentFingerprint?: string;
}

export interface ComputerUseWindowIdentity {
  pid: number;
  windowId: number;
  bundleId?: string;
  appName?: string;
  title?: string;
  bounds?: ComputerUseRect;
  sourceBoundsPx?: ComputerUseRect;
  zIndex?: number;
  contentFingerprint?: string;
  page?: ComputerUsePageIdentity;
}

export interface ComputerUseObservationIdentity extends ComputerUseFrameIdentity {
  capturedAt: number;
  screenshotWidthPx?: number;
  screenshotHeightPx?: number;
  displays: ComputerUseDisplayIdentity[];
  target: ComputerUseWindowIdentity;
}

export interface ComputerUseBoundAction extends ComputerUseFrameIdentity {
  actionFingerprint: string;
  target: ComputerUseWindowIdentity;
  display?: ComputerUseDisplayIdentity;
  elementId?: string;
  sourceCoordinate?: CuPoint;
  sourceStartCoordinate?: CuPoint;
  windowCoordinate?: CuPoint;
  windowStartCoordinate?: CuPoint;
  coordinateSpace?: 'window-screenshot-local';
}

export const CU_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type CuScrollDirection = (typeof CU_SCROLL_DIRECTIONS)[number];

export const CU_ACTION_TYPES = [
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'type',
  'key',
  'hold_key',
  'scroll',
  'wait',
  'zoom',
] as const;

export const COMPUTER_USE_ACTION_TYPES = CU_ACTION_TYPES;
export type CuActionType = (typeof CU_ACTION_TYPES)[number];

export type CuAction =
  | { type: 'screenshot' }
  | { type: 'cursor_position' }
  | { type: 'mouse_move'; coordinate: CuPoint }
  | { type: 'left_click'; coordinate: CuPoint; text?: string }
  | { type: 'right_click'; coordinate: CuPoint; text?: string }
  | { type: 'middle_click'; coordinate: CuPoint; text?: string }
  | { type: 'double_click'; coordinate: CuPoint; text?: string }
  | { type: 'triple_click'; coordinate: CuPoint; text?: string }
  | { type: 'left_mouse_down'; coordinate: CuPoint }
  | { type: 'left_mouse_up'; coordinate: CuPoint }
  | { type: 'left_click_drag'; startCoordinate: CuPoint; coordinate: CuPoint; text?: string }
  | { type: 'type'; text: string }
  | { type: 'key'; text: string }
  | { type: 'hold_key'; text: string; durationMs: number }
  | {
      type: 'scroll';
      coordinate: CuPoint;
      scrollDirection: CuScrollDirection;
      scrollAmount: number;
      text?: string;
    }
  | { type: 'wait'; durationMs: number }
  | { type: 'zoom'; region: CuRegion };

export const COMPUTER_USE_FRAME_SOURCE_KINDS = ['live-capture'] as const;
export type ComputerUseFrameSourceKind = (typeof COMPUTER_USE_FRAME_SOURCE_KINDS)[number];

export interface ComputerUseScreenFrame {
  actionId: string;
  sourceKind: ComputerUseFrameSourceKind;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
  capturedAt: number;
}

export const COMPUTER_USE_DISPATCH_TIERS = [
  'ax',
  'semantic-background',
  'coordinate-background',
] as const;

export type ComputerUseDispatchTier = (typeof COMPUTER_USE_DISPATCH_TIERS)[number];

export const COMPUTER_USE_EFFECTS = ['confirmed', 'unverifiable', 'suspected_noop'] as const;

export type ComputerUseEffect = (typeof COMPUTER_USE_EFFECTS)[number];

export interface ComputerUseDispatchEvidence {
  effect?: ComputerUseEffect;
  reason?: string;
}

export type ComputerUseActionOutcome =
  | {
      ok: true;
      mutation: false;
      tier: ComputerUseDispatchTier;
      verified: boolean;
      evidence?: ComputerUseDispatchEvidence;
      frame?: ComputerUseScreenFrame;
      observation?: ComputerUseObservationIdentity;
      completedSubSteps?: number;
    }
  | {
      ok: true;
      mutation: true;
      tier: ComputerUseDispatchTier;
      verified: boolean;
      evidence?: ComputerUseDispatchEvidence;
      frame?: ComputerUseScreenFrame;
      observation: ComputerUseObservationIdentity;
      completedSubSteps?: number;
    }
  | {
      ok: false;
      error: ComputerUseErrorCode;
      message: string;
      evidence?: ComputerUseDispatchEvidence;
      completedSubSteps?: number;
    };

/**
 * Approval is a capability gate, not proof that an action is fresh or valid.
 * Runtime must still establish an active observation and validate the target.
 */
export const COMPUTER_USE_APPROVAL_CLASSES = [
  'metadata_read',
  'screenshot_read',
  'pointer_mutation',
  'keyboard_mutation',
  'semantic_mutation',
] as const;

export type ComputerUseApprovalClass = (typeof COMPUTER_USE_APPROVAL_CLASSES)[number];

export interface ComputerUseApprovalSummary {
  action: string;
  approvalClass: ComputerUseApprovalClass;
  rememberForTurnAllowed: boolean;
  app?: string;
  windowId?: number;
  observationId?: string;
}

/**
 * The call as the model should read it back: its own arguments, in the names
 * the tool accepts.
 *
 * The approval summary above is the host's projection for deciding and
 * displaying a permission. It was also being written into the model-facing
 * record of the call, and that had a cost nobody was watching for: the model's
 * transcript said it had called `maka_computer` with `approvalClass`,
 * `rememberForTurnAllowed` and `windowId` — two host-only fields and a key in a
 * dialect the tool rejects — so it went on calling it that way. A real desktop
 * run failed six of eleven calls on shapes copied from its own history, and the
 * telemetry file on this machine holds 29 such rejections.
 *
 * Same privacy boundary as the summary: typed text, written values and
 * coordinates are screen-derived and stay out. Element ids do not — an element
 * id is an index into one observation, and withholding it is what left the
 * model unable to see which control it had just acted on.
 *
 * Accepts either dialect on input, so it can project raw arguments or an
 * approval summary recovered from storage.
 */
export interface ComputerUseModelCallArgs {
  action: string;
  app?: string;
  window_id?: number;
  observation_id?: string;
  element_id?: string;
}

export function computerUseModelCallArgs(args: unknown): ComputerUseModelCallArgs {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  const action =
    typeof rawAction === 'string' && APPROVAL_ACTIONS.has(rawAction) ? rawAction : 'unknown';
  const app = ownDataProperty(record, 'app');
  const windowId = ownDataProperty(record, 'window_id') ?? ownDataProperty(record, 'windowId');
  const observationId =
    ownDataProperty(record, 'observation_id') ?? ownDataProperty(record, 'observationId');
  const elementId = ownDataProperty(record, 'element_id') ?? ownDataProperty(record, 'elementId');
  return {
    action,
    ...(typeof app === 'string' && app.length > 0
      ? { app: boundedDisplay(redactSecrets(app), 256) }
      : {}),
    ...(typeof windowId === 'number' && Number.isInteger(windowId) ? { window_id: windowId } : {}),
    ...(typeof observationId === 'string' && stableIdentifier(observationId)
      ? { observation_id: stableIdentifier(observationId) }
      : {}),
    ...(typeof elementId === 'string' && elementId.length > 0
      ? { element_id: boundedDisplay(redactSecrets(elementId), 256) }
      : {}),
  };
}

const POINTER_ACTIONS = new Set([
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'left_click_drag',
  'scroll',
  'zoom',
]);

const KEYBOARD_ACTIONS = new Set(['type', 'key', 'hold_key', 'press_key']);
const SEMANTIC_ACTIONS = new Set([
  'click_element',
  'set_value',
  'select_text',
  'secondary_action',
  // Scrolling an element moves what is on screen without changing any value.
  // It is still a mutation of the target's state, and it is the semantic twin
  // of the coordinate `scroll` that already sits in POINTER_ACTIONS.
  'scroll_element',
  // A sequence of element actions is still element actions: same class, same
  // approval, one call.
  'element_sequence',
  // Starting an app changes what is on screen. It touches no element, but it
  // is not a read, and letting it fall through to the default would have
  // classified it correctly by accident rather than on purpose.
  'launch_app',
]);

const APPROVAL_ACTIONS = new Set([
  'list_apps',
  'launch_app',
  'observe',
  'click_element',
  'set_value',
  'select_text',
  'secondary_action',
  'scroll_element',
  'element_sequence',
  'press_key',
  ...CU_ACTION_TYPES,
]);

export function computerUseApprovalSummary(args: unknown): ComputerUseApprovalSummary {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  const knownAction = typeof rawAction === 'string' && APPROVAL_ACTIONS.has(rawAction);
  const action = knownAction ? rawAction : 'unknown';
  const includeScreenshot = ownDataProperty(record, 'include_screenshot') !== false;
  const approvalClass: ComputerUseApprovalClass =
    action === 'list_apps' || action === 'cursor_position' || action === 'wait'
      ? 'metadata_read'
      : action === 'observe'
        ? includeScreenshot
          ? 'screenshot_read'
          : 'metadata_read'
        : action === 'screenshot'
          ? 'screenshot_read'
          : POINTER_ACTIONS.has(action)
            ? 'pointer_mutation'
            : KEYBOARD_ACTIONS.has(action)
              ? 'keyboard_mutation'
              : SEMANTIC_ACTIONS.has(action)
                ? 'semantic_mutation'
                : 'semantic_mutation';

  const rawApp = ownDataProperty(record, 'app');
  const rawWindowId = ownDataProperty(record, 'window_id');
  const rawObservationId = ownDataProperty(record, 'observation_id');
  const exactApp = typeof rawApp === 'string' && rawApp.length > 0 ? rawApp : undefined;
  const app = exactApp === undefined ? undefined : boundedDisplay(redactSecrets(exactApp), 256);
  const windowId =
    typeof rawWindowId === 'number' && Number.isInteger(rawWindowId) ? rawWindowId : undefined;
  const exactObservationId =
    typeof rawObservationId === 'string' ? stableIdentifier(rawObservationId) : undefined;
  const observationId =
    exactObservationId === undefined
      ? undefined
      : boundedDisplay(redactSecrets(exactObservationId), 256);
  const explicitTarget = exactApp !== undefined || windowId !== undefined;
  const targetBound =
    action === 'list_apps' ||
    ((action === 'observe' || action === 'screenshot') && explicitTarget) ||
    ((POINTER_ACTIONS.has(action) ||
      KEYBOARD_ACTIONS.has(action) ||
      SEMANTIC_ACTIONS.has(action)) &&
      exactObservationId !== undefined &&
      explicitTarget);
  const rememberForTurnAllowed = knownAction && targetBound;

  return {
    action,
    approvalClass,
    rememberForTurnAllowed,
    ...(app === undefined ? {} : { app }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(observationId === undefined ? {} : { observationId }),
  };
}

export function computerUseApprovalScopeKey(args: unknown): string {
  const record = asRecord(args);
  const rawAction = ownDataProperty(record, 'action');
  const exactAction = typeof rawAction === 'string' ? rawAction : null;
  const rawApp = ownDataProperty(record, 'app');
  const exactApp = typeof rawApp === 'string' ? rawApp : null;
  const rawWindowId = ownDataProperty(record, 'window_id');
  const exactWindowId =
    typeof rawWindowId === 'number' && Number.isInteger(rawWindowId) ? rawWindowId : null;
  const rawObservationId = ownDataProperty(record, 'observation_id');
  const exactObservationId = typeof rawObservationId === 'string' ? rawObservationId : null;
  const summary = computerUseApprovalSummary(record);
  return `computer_use:${JSON.stringify([
    summary.approvalClass,
    exactAction,
    exactApp,
    exactWindowId,
    exactObservationId,
  ])}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function boundedDisplay(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function stableIdentifier(value: string): string | undefined {
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,256}$/.test(normalized) ? normalized : undefined;
}

function ownDataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    throw new Error(`Computer Use approval requires ${key} to be a plain data property`);
  }
  return descriptor.value;
}

/**
 * Whether the model may drive the machine at all.
 *
 * Computer Use is gated by the tool, not by the application it is pointed at.
 * That is how everything else in Maka is gated — `load_tools` admits tools,
 * plan mode strips them, the tool surface is assembled per turn — and adding an
 * application axis would be a second dimension nothing else has, paid for with
 * a per-app grant store and a revocation screen, to ask a question ("allow Maka
 * to use 词典?") that a person cannot weigh and will answer yes to.
 *
 * It also is not a substitute for the macOS grants. Accessibility and Screen
 * Recording are what actually let anything happen; this decides whether Maka
 * offers the capability to the model in the first place.
 *
 * Off by default. Turning on a capability that reads the screen and presses
 * buttons is a decision, not a migration.
 */
export interface ComputerUseSettings {
  readonly enabled: boolean;
}

export type ComputerUseSettingsPatch = Partial<{ enabled: boolean }>;

export function defaultComputerUseSettings(): ComputerUseSettings {
  return { enabled: false };
}

export function mergeComputerUseSettings(
  current: ComputerUseSettings | undefined,
  patch: ComputerUseSettingsPatch | undefined,
): ComputerUseSettings {
  const base = current ?? defaultComputerUseSettings();
  if (!patch) return base;
  return { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled };
}
