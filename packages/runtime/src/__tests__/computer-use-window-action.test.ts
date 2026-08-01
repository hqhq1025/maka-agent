// Moving a window, which was always possible and had no way to be said.
//
// A model asked to move a window reached for a title-bar drag — the only route a
// person has — which needs a coordinate, which needs the window not to be
// covered, which a window driven from the background always is. It spent 57
// calls on that in one run.
//
// `AXPosition` is settable on every window measured (17 of 17), `AXSize` on 14,
// and writing either does not bring the application forward. The capability was
// there; the vocabulary was not.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computerParams } from '../computer-use-codec.js';

function parse(input: unknown) {
  return computerParams.safeParse(input);
}

test('a move names where to put the window', () => {
  const ok = parse({
    action: 'window_action',
    observation_id: 'obs_1',
    element_id: '0',
    window_action: 'move',
    position: [220, 164],
  });
  assert.equal(ok.success, true);
});

test('a move without a position is rejected rather than guessed at', () => {
  const bad = parse({
    action: 'window_action',
    observation_id: 'obs_1',
    element_id: '0',
    window_action: 'move',
  });
  assert.equal(bad.success, false);
});

test('a resize names a size, and a size is positive', () => {
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'resize',
      size: [800, 600],
    }).success,
    true,
  );
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'resize',
      size: [0, 600],
    }).success,
    false,
  );
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'resize',
    }).success,
    false,
  );
});

test('minimise needs no geometry', () => {
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'minimize',
    }).success,
    true,
  );
});

test('a negative position is accepted, because a second display is a real place', () => {
  // Measured on this machine: display 2 sits at (-193, -1080) in the space the
  // observation reports. Refusing a negative coordinate would make half the
  // desktop unaddressable, and macOS clamps what it will not honour anyway.
  const ok = parse({
    action: 'window_action',
    observation_id: 'obs_1',
    element_id: '0',
    window_action: 'move',
    position: [-193, -1049],
  });
  assert.equal(ok.success, true);
});

test('an action outside the three is not a window action', () => {
  assert.equal(
    parse({
      action: 'window_action',
      observation_id: 'obs_1',
      element_id: '0',
      window_action: 'close',
    }).success,
    false,
  );
});
