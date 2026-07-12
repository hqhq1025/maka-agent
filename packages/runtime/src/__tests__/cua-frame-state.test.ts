import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bindCuaAction,
  bindCuaActionToObservation,
  CuaFrameState,
} from '../cua-frame-state.js';

function createState(): CuaFrameState {
  let nextFrameId = 1;
  return new CuaFrameState(() => `frame-${nextFrameId++}`);
}

describe('CuaFrameState', () => {
  test('creates a new frame identity for every observation', () => {
    const state = createState();

    assert.deepEqual(
      (({ frameId, epoch }) => ({ frameId, epoch }))(state.observe()),
      { frameId: 'frame-1', epoch: 0 },
    );
    assert.deepEqual(
      (({ frameId, epoch }) => ({ frameId, epoch }))(state.observe()),
      { frameId: 'frame-2', epoch: 0 },
    );
  });

  test('binds an action fingerprint to its observed frame', () => {
    const state = createState();
    const first = bindCuaAction(state.observe(), 'click:10,20');
    const second = bindCuaAction(state.observe(), 'click:10,20');

    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(first.frameId, 'frame-1');
    assert.equal(second.frameId, 'frame-2');
  });

  test('rejects an action from a superseded frame', () => {
    const state = createState();
    const oldAction = bindCuaAction(state.observe(), 'click:10,20');
    state.observe();

    assert.deepEqual(state.claimAction(oldAction), {
      ok: false,
      reason: 'stale_frame',
    });
  });

  test('rejects the same action twice on one frame', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'click:10,20');

    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'duplicate_action',
    });
  });

  test('keeps a consumed action fingerprint rejected after epoch advancement', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'click:10,20');
    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.confirmAction(action), { ok: true, epoch: 1 });
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'duplicate_action',
    });
  });

  test('rejects old actions after invalidation', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'click:10,20');

    assert.equal(state.invalidate(), 1);
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'no_active_frame',
    });
    assert.deepEqual(
      (({ frameId, epoch }) => ({ frameId, epoch }))(state.observe()),
      { frameId: 'frame-2', epoch: 1 },
    );
    assert.deepEqual(state.claimAction(action), {
      ok: false,
      reason: 'stale_epoch',
    });
  });

  test('advances the epoch only after confirming a claimed action', () => {
    const state = createState();
    const action = bindCuaAction(state.observe(), 'type:hello');

    assert.deepEqual(state.confirmAction(action), {
      ok: false,
      reason: 'action_not_claimed',
    });
    assert.deepEqual(state.claimAction(action), { ok: true });
    assert.deepEqual(state.confirmAction(action), { ok: true, epoch: 1 });
    assert.deepEqual(
      (({ frameId, epoch }) => ({ frameId, epoch }))(state.observe()),
      { frameId: 'frame-2', epoch: 1 },
    );
  });

  test('binds coordinates to the screenshot-time highest-z window and window-local pixels', () => {
    const state = createState();
    const frame = state.observe({
      capturedAt: 10,
      screenshotWidthPx: 2000,
      screenshotHeightPx: 1200,
      displays: [{
        displayId: 'main',
        logicalBounds: { x: 0, y: 0, width: 1000, height: 600 },
        sourceBoundsPx: { x: 0, y: 0, width: 2000, height: 1200 },
        scaleFactor: 2,
      }],
      windows: [
        {
          pid: 1,
          windowId: 10,
          bounds: { x: 50, y: 50, width: 400, height: 300 },
          sourceBoundsPx: { x: 100, y: 100, width: 800, height: 600 },
          zIndex: 1,
        },
        {
          pid: 2,
          windowId: 20,
          bounds: { x: 100, y: 75, width: 200, height: 150 },
          sourceBoundsPx: { x: 200, y: 150, width: 400, height: 300 },
          zIndex: 9,
        },
      ],
    });
    const bound = bindCuaActionToObservation(frame, {
      type: 'left_click',
      coordinate: { x: 300, y: 250 },
    });
    assert.equal(bound?.target?.pid, 2);
    assert.equal(bound?.target?.windowId, 20);
    assert.deepEqual(bound?.displayLogicalCoordinate, { x: 150, y: 125 });
    assert.deepEqual(bound?.windowCoordinate, { x: 100, y: 100 });
  });

  test('refuses a drag whose screenshot-time endpoints belong to different windows', () => {
    const state = createState();
    const frame = state.observe({
      capturedAt: 10,
      screenshotWidthPx: 1000,
      screenshotHeightPx: 600,
      displays: [{
        displayId: 'main',
        logicalBounds: { x: 0, y: 0, width: 1000, height: 600 },
        sourceBoundsPx: { x: 0, y: 0, width: 1000, height: 600 },
        scaleFactor: 1,
      }],
      windows: [
        {
          pid: 1,
          windowId: 10,
          bounds: { x: 0, y: 0, width: 400, height: 400 },
          sourceBoundsPx: { x: 0, y: 0, width: 400, height: 400 },
          zIndex: 1,
        },
        {
          pid: 2,
          windowId: 20,
          bounds: { x: 500, y: 0, width: 400, height: 400 },
          sourceBoundsPx: { x: 500, y: 0, width: 400, height: 400 },
          zIndex: 1,
        },
      ],
    });
    assert.equal(bindCuaActionToObservation(frame, {
      type: 'left_click_drag',
      startCoordinate: { x: 100, y: 100 },
      coordinate: { x: 600, y: 100 },
    }), undefined);
  });

  test('binds a negative-origin display through its source atlas', () => {
    const state = createState();
    const frame = state.observe({
      capturedAt: 10,
      screenshotWidthPx: 2000,
      screenshotHeightPx: 800,
      displays: [
        {
          displayId: 'left',
          logicalBounds: { x: -1000, y: 0, width: 1000, height: 800 },
          sourceBoundsPx: { x: 0, y: 0, width: 1000, height: 800 },
          scaleFactor: 1,
        },
        {
          displayId: 'main',
          logicalBounds: { x: 0, y: 0, width: 1000, height: 800 },
          sourceBoundsPx: { x: 1000, y: 0, width: 1000, height: 800 },
          scaleFactor: 1,
        },
      ],
      windows: [{
        pid: 9,
        windowId: 90,
        bounds: { x: -900, y: 100, width: 400, height: 300 },
        sourceBoundsPx: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 4,
      }],
    });
    const bound = bindCuaActionToObservation(frame, {
      type: 'left_click',
      coordinate: { x: 250, y: 200 },
    });
    assert.equal(bound?.display?.displayId, 'left');
    assert.deepEqual(bound?.displayLogicalCoordinate, { x: -750, y: 200 });
    assert.deepEqual(bound?.windowCoordinate, { x: 150, y: 100 });
  });
});
