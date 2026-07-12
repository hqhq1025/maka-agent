import { randomUUID } from 'node:crypto';
import type { CuAction, CuPoint } from '@maka/core';

export interface CuaFrameIdentity {
  frameId: string;
  epoch: number;
}

export interface CuaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CuaDisplaySnapshot {
  displayId: string;
  logicalBounds: CuaRect;
  sourceBoundsPx: CuaRect;
  scaleFactor: number;
}

export interface CuaPageIdentity {
  cdpPort: number;
  pageTargetId: string;
  pageUrl: string;
  targetUrlContains: string;
  documentFingerprint?: string;
}

export interface CuaWindowIdentity {
  pid: number;
  windowId: number;
  bundleId?: string;
  appName?: string;
  title?: string;
  bounds: CuaRect;
  sourceBoundsPx: CuaRect;
  zIndex: number;
  contentFingerprint?: string;
  page?: CuaPageIdentity;
}

export interface CuaObservationSnapshot {
  capturedAt: number;
  screenshotWidthPx: number;
  screenshotHeightPx: number;
  displays: CuaDisplaySnapshot[];
  windows: CuaWindowIdentity[];
}

export interface CuaObservation extends CuaFrameIdentity, CuaObservationSnapshot {}

export interface CuaBoundAction {
  frameId: string;
  epoch: number;
  actionFingerprint: string;
  fingerprint: string;
  target?: CuaWindowIdentity;
  display?: CuaDisplaySnapshot;
  sourceCoordinate?: CuPoint;
  sourceStartCoordinate?: CuPoint;
  displayLogicalCoordinate?: CuPoint;
  displayLogicalStartCoordinate?: CuPoint;
  windowCoordinate?: CuPoint;
  windowStartCoordinate?: CuPoint;
}

export type CuaActionRejectionReason =
  | 'invalid_binding'
  | 'no_active_frame'
  | 'stale_epoch'
  | 'stale_frame'
  | 'duplicate_action'
  | 'action_not_claimed';

export type CuaActionClaimResult =
  | { ok: true }
  | { ok: false; reason: CuaActionRejectionReason };

export type CuaActionConfirmationResult =
  | { ok: true; epoch: number }
  | { ok: false; reason: CuaActionRejectionReason };

export type CuaFrameIdFactory = (epoch: number) => string;

export function bindCuaAction(
  frame: CuaFrameIdentity,
  actionFingerprint: string,
): CuaBoundAction {
  return {
    ...frame,
    actionFingerprint,
    fingerprint: JSON.stringify([frame.frameId, actionFingerprint]),
  };
}

export class CuaFrameState {
  private epoch = 0;
  private currentFrame: CuaObservation | undefined;
  private readonly claimedActions = new Set<string>();
  private readonly consumedActions = new Set<string>();

  constructor(
    private readonly createFrameId: CuaFrameIdFactory = () => randomUUID(),
  ) {}

  observe(snapshot: CuaObservationSnapshot = {
    capturedAt: Date.now(),
    screenshotWidthPx: 1,
    screenshotHeightPx: 1,
    displays: [],
    windows: [],
  }): CuaObservation {
    const frame = {
      frameId: this.createFrameId(this.epoch),
      epoch: this.epoch,
      ...snapshot,
    };
    this.currentFrame = frame;
    this.claimedActions.clear();
    return frame;
  }

  invalidate(): number {
    this.epoch += 1;
    this.currentFrame = undefined;
    this.claimedActions.clear();
    return this.epoch;
  }

  claimAction(action: CuaBoundAction): CuaActionClaimResult {
    if (this.consumedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'duplicate_action' };
    }
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'duplicate_action' };
    }
    this.claimedActions.add(action.fingerprint);
    return { ok: true };
  }

  confirmAction(action: CuaBoundAction): CuaActionConfirmationResult {
    const rejection = this.validateAction(action);
    if (rejection) return { ok: false, reason: rejection };
    if (!this.claimedActions.has(action.fingerprint)) {
      return { ok: false, reason: 'action_not_claimed' };
    }
    this.consumedActions.add(action.fingerprint);
    return { ok: true, epoch: this.invalidate() };
  }

  activeObservation(): CuaObservation | undefined {
    return this.currentFrame;
  }

  isConsumed(frame: CuaFrameIdentity, actionFingerprint: string): boolean {
    return this.consumedActions.has(
      bindCuaAction(frame, actionFingerprint).fingerprint,
    );
  }

  private validateAction(action: CuaBoundAction): CuaActionRejectionReason | undefined {
    if (bindCuaAction(action, action.actionFingerprint).fingerprint !== action.fingerprint) {
      return 'invalid_binding';
    }
    if (!this.currentFrame) return 'no_active_frame';
    if (action.epoch !== this.epoch) return 'stale_epoch';
    if (action.frameId !== this.currentFrame.frameId) return 'stale_frame';
    return undefined;
  }
}

function pointInside(point: CuPoint, rect: CuaRect): boolean {
  return point.x >= rect.x
    && point.x < rect.x + rect.width
    && point.y >= rect.y
    && point.y < rect.y + rect.height;
}

function bindPoint(
  observation: CuaObservation,
  sourceCoordinate: CuPoint,
): {
  target: CuaWindowIdentity;
  display: CuaDisplaySnapshot;
  displayLogicalCoordinate: CuPoint;
  windowCoordinate: CuPoint;
} | undefined {
  const display = observation.displays.find((candidate) =>
    pointInside(sourceCoordinate, candidate.sourceBoundsPx));
  if (!display) return undefined;
  const displayLogicalCoordinate = {
    x: display.logicalBounds.x
      + (sourceCoordinate.x - display.sourceBoundsPx.x) / display.scaleFactor,
    y: display.logicalBounds.y
      + (sourceCoordinate.y - display.sourceBoundsPx.y) / display.scaleFactor,
  };
  const target = observation.windows
    .filter((candidate) => pointInside(sourceCoordinate, candidate.sourceBoundsPx))
    .sort((left, right) => right.zIndex - left.zIndex)[0];
  if (!target) return undefined;
  return {
    target,
    display,
    displayLogicalCoordinate,
    windowCoordinate: {
      x: sourceCoordinate.x - target.sourceBoundsPx.x,
      y: sourceCoordinate.y - target.sourceBoundsPx.y,
    },
  };
}

export function fingerprintCuaAction(action: CuAction): string {
  return JSON.stringify(action);
}

export function bindCuaActionToObservation(
  observation: CuaObservation,
  action: CuAction,
): CuaBoundAction | undefined {
  const actionFingerprint = fingerprintCuaAction(action);
  const base = bindCuaAction(observation, actionFingerprint);
  if (action.type === 'zoom') {
    const start = bindPoint(observation, {
      x: Math.min(action.region.x1, action.region.x2),
      y: Math.min(action.region.y1, action.region.y2),
    });
    const end = bindPoint(observation, {
      x: Math.max(action.region.x1, action.region.x2),
      y: Math.max(action.region.y1, action.region.y2),
    });
    if (
      !start
      || !end
      || start.target.pid !== end.target.pid
      || start.target.windowId !== end.target.windowId
    ) return undefined;
    return {
      ...base,
      target: end.target,
      display: end.display,
      sourceStartCoordinate: {
        x: Math.min(action.region.x1, action.region.x2),
        y: Math.min(action.region.y1, action.region.y2),
      },
      sourceCoordinate: {
        x: Math.max(action.region.x1, action.region.x2),
        y: Math.max(action.region.y1, action.region.y2),
      },
      displayLogicalStartCoordinate: start.displayLogicalCoordinate,
      displayLogicalCoordinate: end.displayLogicalCoordinate,
      windowStartCoordinate: start.windowCoordinate,
      windowCoordinate: end.windowCoordinate,
    };
  }
  if ('coordinate' in action) {
    const end = bindPoint(observation, action.coordinate);
    if (!end) return undefined;
    if (action.type === 'left_click_drag') {
      const start = bindPoint(observation, action.startCoordinate);
      if (
        !start
        || start.target.pid !== end.target.pid
        || start.target.windowId !== end.target.windowId
      ) return undefined;
      return {
        ...base,
        target: end.target,
        display: end.display,
        sourceCoordinate: action.coordinate,
        sourceStartCoordinate: action.startCoordinate,
        displayLogicalCoordinate: end.displayLogicalCoordinate,
        displayLogicalStartCoordinate: start.displayLogicalCoordinate,
        windowCoordinate: end.windowCoordinate,
        windowStartCoordinate: start.windowCoordinate,
      };
    }
    return {
      ...base,
      target: end.target,
      display: end.display,
      sourceCoordinate: action.coordinate,
      displayLogicalCoordinate: end.displayLogicalCoordinate,
      windowCoordinate: end.windowCoordinate,
    };
  }
  return base;
}
