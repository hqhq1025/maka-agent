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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCursorOverlayController, cursorOverlayWindowOptions,
  type CursorOverlayWindowLike } from '../computer-use/cursor-overlay-window.js';

test('persistent cursor overlay keeps animation frames unthrottled in the background', () => {
  const options = cursorOverlayWindowOptions(
    { x: 0, y: 0, width: 1920, height: 1080 },
    '/tmp/cursor-overlay-preload.cjs',
  );

  assert.equal(options.webPreferences?.backgroundThrottling, false);
});

function fixture() {
  let allowed = true;
  let ready: (() => void) | undefined;
  let phase: Parameters<CursorOverlayWindowLike['onPresentationPhase']>[0] | undefined;
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let destroyed = 0;
  let shown = 0;
  let created = 0;
  const controller = createCursorOverlayController({
    mayPresent: () => allowed,
    resolveScreenPoint: ({ x, y }) => ({ x: x / 2, y: y / 2 }),
    resolveOverlayBounds: () => ({ x: -100, y: 0, width: 1000, height: 800 }),
    subscribeDisplayChanges: () => () => {},
    createOverlayWindow: () => {
      created += 1;
      let gone = false;
      return {
        setIgnoreMouseEvents() {}, setAlwaysOnTop() {}, moveAbove() {},
        setVisibleOnAllWorkspaces() {}, loadFile: async () => {},
        showInactive() { shown += 1; }, isDestroyed: () => gone,
        destroy() { destroyed += 1; gone = true; },
        send(channel, payload) { sent.push({ channel, payload: payload as Record<string, unknown> }); },
        onReady(callback) { ready = callback; }, onGone() {},
        onPresentationPhase(callback) { phase = callback; },
      };
    },
  });
  return { controller, sent, ready: () => ready?.(),
    phase: (value: Parameters<NonNullable<typeof phase>>[0]) => phase?.(value),
    allow: (value: boolean) => { allowed = value; },
    counts: () => ({ destroyed, shown, created }),
  };
}

const move = { sessionId: 's1', actionId: 'a1', screenX: 600, screenY: 400,
  kind: 'click' as const, targetWindowId: 7, instant: true };

test('physical desktop points are converted to DIP before overlay-local placement', () => {
  const f = fixture();
  f.controller.move(move);
  f.ready();
  const rendered = f.sent.find((event) => event.channel === 'overlay:move')!.payload;
  assert.equal(rendered.x, 400); // 600px -> 300 DIP, with origin -100 DIP
  assert.equal(rendered.y, 200);
  assert.equal(rendered.instant, true);
});

test('Stop destroys immediately and neither late load nor completion restores the cursor', async () => {
  const f = fixture();
  const fence = f.controller.move(move);
  f.controller.clearForSession('s1');
  await Promise.all([fence.readyForInteraction, fence.finished]);
  f.ready();
  f.controller.complete({ ...move, pulse: true });
  assert.deepEqual(f.counts(), { destroyed: 1, shown: 0, created: 1 });
  assert.equal(f.sent.length, 0);
  assert.equal(f.controller.isActive(), false);
});

test('a lock or retired Desktop blocks late show and new presentation', () => {
  const f = fixture();
  f.controller.move(move);
  f.allow(false);
  f.ready();
  f.controller.move({ ...move, actionId: 'late' });
  f.controller.complete({ ...move, pulse: true });
  assert.deepEqual(f.counts(), { destroyed: 1, shown: 0, created: 1 });
  assert.equal(f.controller.isActive(), false);
});

test('refusal removes its cursor immediately, and an old refusal cannot remove a new action', async () => {
  const f = fixture();
  const first = f.controller.move(move);
  f.ready();
  f.controller.move({ ...move, actionId: 'a2' });
  f.controller.cancel(move);
  assert.equal(f.controller.isActive(), true);
  f.controller.cancel({ sessionId: 's1', actionId: 'a2' });
  assert.equal(f.controller.isActive(), false);
  await Promise.all([first.readyForInteraction, first.finished]);
  f.controller.complete({ ...move, actionId: 'a2', pulse: true });
  assert.equal(f.counts().created, 1);
  assert.equal(f.counts().destroyed, 1);
});

test('a completion after the finished acknowledgement cannot show the cursor again', () => {
  const f = fixture();
  f.controller.move(move);
  f.ready();
  f.controller.complete({ ...move, pulse: true });
  f.phase({ sessionId: 's1', generation: 1, actionId: 'a1', phase: 'finished' });
  const count = f.sent.length;
  f.controller.complete({ ...move, pulse: true });
  assert.equal(f.sent.length, count);
});

test('unavailable global coordinates and points outside the desktop do not create a cursor', () => {
  let created = 0;
  const controller = createCursorOverlayController({
    resolveScreenPoint: () => undefined,
    createOverlayWindow: () => { created += 1; throw new Error('must not create'); },
  });
  controller.move(move);
  assert.equal(created, 0);
  const f = fixture();
  f.controller.move({ ...move, screenX: 99999 });
  assert.equal(f.controller.isActive(), false);
  assert.equal(f.counts().shown, 0);
});
