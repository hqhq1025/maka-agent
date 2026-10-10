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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { claimPreviewSession, closePreviewSurface, createComputerUseWindowPreview, exactPreviewSource, type ComputerUsePreviewTarget, type PreviewSurface } from '../computer-use/window-preview.js';
import type { ComputerUsePreviewTargetListener } from '../computer-use/window-identity.js';

const bounds = { x: 20, y: 30, width: 320, height: 200 };
const target: ComputerUsePreviewTarget = {
  sessionId: 'task', revision: 1, pid: 12, windowId: 44, appName: 'Fixture', leaseId: 'native-lease',
};

test('destroyed parent and permission teardown errors cannot skip native capturer close', () => {
  const calls: string[] = [];
  closePreviewSurface({
    deny() { calls.push('deny'); throw new Error('session gone'); },
    hide() { calls.push('hide'); throw new Error('view gone'); },
    detach() { calls.push('detach'); throw new Error('parent destroyed'); },
    close() { calls.push('close'); },
  });
  assert.deepEqual(calls, ['deny', 'hide', 'detach', 'close']);
});

test('sequential previews reuse one private Session and late old capturer teardown cannot revoke the new policy', () => {
  const owner = {};
  const slots = new WeakMap<object, { session: object; current?: object }>();
  let created = 0;
  const create = () => { created++; return {}; };
  const old = claimPreviewSession(slots, owner, create);
  const next = claimPreviewSession(slots, owner, create);
  assert.equal(created, 1);
  assert.equal(next.session, old.session);
  assert.equal(old.current(), false);
  assert.equal(old.release(), false);
  assert.equal(next.current(), true);
  assert.equal(next.release(), true);
  assert.equal(next.current(), false);
  claimPreviewSession(slots, {}, create);
  assert.equal(created, 2);
});

function fixture(overrides: Partial<Parameters<typeof createComputerUseWindowPreview<object>>[0]> = {}) {
  const owner = {};
  let accepted: ComputerUsePreviewTarget | null = target;
  let listener: ComputerUsePreviewTargetListener | undefined;
  let destroyed = 0;
  let created = 0;
  let state = 'live';
  const changes: Array<{ state: string; reason?: string }> = [];
  const surface: PreviewSurface = {
    setBounds() {}, async start() {}, async state() { return state; }, destroy() { destroyed++; },
  };
  const preview = createComputerUseWindowPreview<object>({
    platform: 'win32', target: () => accepted,
    subscribeTarget: (_key, next) => { listener = next; return () => { listener = undefined; }; },
    validateTarget: () => true, locked: () => false, visible: () => true,
    sources: async () => [{ id: 'window:44:0', name: 'Fixture' }],
    createSurface: async () => { created++; return surface; },
    changed: (_owner, change) => changes.push(change), ...overrides,
  });
  return {
    owner, preview, changes, destroyed: () => destroyed, created: () => created,
    replace(value: ComputerUsePreviewTarget | null, reason: 'target_changed' | 'stopped' = 'target_changed') { accepted = value; listener?.(value, reason); },
    state(value: string) { state = value; },
  };
}

test('exact source requires one native window ID and never title or full-screen fallback', () => {
  assert.equal(exactPreviewSource([{ id: 'screen:44:0', name: 'Fixture' }], 44), undefined);
  assert.equal(exactPreviewSource([{ id: 'window:45:0', name: 'Fixture' }], 44), undefined);
  assert.equal(exactPreviewSource([{ id: 'window:44:0', name: 'Fixture' }, { id: 'window:44:1', name: 'Fixture' }], 44), undefined);
  assert.equal(exactPreviewSource([{ id: 'window:44:0', name: 'Changed title' }], 44)?.id, 'window:44:0');
});

test('Mac capture receives the retained target without entering Electron display capture', async () => {
  let received: ComputerUsePreviewTarget | undefined;
  const f = fixture({ platform: 'darwin', sources: async () => { throw new Error('NV12 route must not run'); },
    createSurface: async (_owner, _bounds, source, authorize, nativeTarget) => {
      assert.equal(source, undefined);
      assert.equal(authorize(), true);
      received = nativeTarget;
      return { setBounds() {}, async start() {}, async state() { return 'live'; }, destroy() {} };
    },
  });
  await f.preview.start(f.owner, 'task', 'ui', bounds);
  assert.equal(received, target);
  await f.preview.check();
  assert.equal(f.changes.at(-1)?.state, 'live');
  f.preview.dispose();
});

test('an open preview follows a newly accepted target after ending the old capture', async () => {
  const f = fixture();
  assert.equal((await f.preview.start(f.owner, 'task', 'ui-lease', bounds)).state, 'starting');
  await f.preview.check();
  assert.equal(f.changes.at(-1)?.state, 'live');
  f.replace({ ...target, leaseId: 'next-native-lease' });
  assert.equal(f.destroyed(), 1);
  await Promise.resolve(); await Promise.resolve();
  await f.preview.check();
  assert.equal(f.created(), 2);
  assert.deepEqual(f.changes.at(-1), { leaseId: 'ui-lease', state: 'live' });
  assert.equal(f.destroyed(), 1);
  f.preview.dispose();
});

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform} preview waits after identity loss and resumes only for a fresh accepted lease`, async () => {
    let valid = true;
    const f = fixture({ platform, validateTarget: () => valid });
    await f.preview.start(f.owner, 'task', 'ui', bounds);
    await f.preview.check();
    valid = false;
    await f.preview.check();
    assert.equal(f.destroyed(), 1);
    assert.equal(f.changes.at(-1)?.state, 'waiting');
    valid = true;
    f.replace(target);
    await f.preview.check();
    assert.equal(f.created(), 1, 'revoked capture cannot resume from the old lease');
    f.replace(null);
    f.replace({ ...target, leaseId: 'fresh' });
    await Promise.resolve(); await Promise.resolve();
    await f.preview.check();
    assert.equal(f.created(), 2);
    assert.deepEqual(f.changes.at(-1), { leaseId: 'ui', state: 'live' });
    f.preview.dispose();
  });
}

for (const pending of ['loading', 'load-error', 'first-frame'] as const) {
  test(`replacing a target during ${pending} cannot let the old capture authorize or stop its successor`, async () => {
    const entered = deferred<void>();
    const loaded = deferred<PreviewSurface>();
    const oldState = deferred<string>();
    const reading = deferred<void>();
    const resumed = deferred<void>();
    const authorize: (() => boolean)[] = [];
    let oldDestroyed = 0, newDestroyed = 0;
    const oldSurface: PreviewSurface = { setBounds() {}, async start() {},
      state() { reading.resolve(); return oldState.promise; }, destroy() { oldDestroyed++; } };
    const f = fixture({ platform: 'darwin',
      createSurface: async (_owner, _bounds, _source, allowed, nativeTarget) => {
        authorize.push(allowed);
        if (nativeTarget.leaseId === target.leaseId) {
          entered.resolve();
          return pending === 'first-frame' ? oldSurface : loaded.promise;
        }
        return { setBounds() {}, async start() { resumed.resolve(); }, async state() { return 'live'; }, destroy() { newDestroyed++; } };
      },
    });
    const opening = f.preview.start(f.owner, 'task', 'ui', bounds);
    await entered.promise;
    let checking: Promise<void> | undefined;
    if (pending === 'first-frame') {
      await opening;
      checking = f.preview.check();
      await reading.promise;
    }
    f.replace({ ...target, leaseId: 'successor' });
    await resumed.promise;
    assert.equal(authorize[0]!(), false);
    assert.equal(authorize[1]!(), true);
    if (pending === 'loading') loaded.resolve(oldSurface);
    else if (pending === 'load-error') loaded.reject(new Error('old child failed to load'));
    else oldState.resolve('capture_failed');
    await opening;
    await checking;
    await f.preview.check();
    assert.equal(f.changes.at(-1)?.state, 'live');
    assert.equal(newDestroyed, 0);
    assert.equal(oldDestroyed, pending === 'load-error' ? 0 : 1);
    f.preview.dispose();
  });
}

test('closing or hiding a waiting preview cancels following and preserves the last measured bounds', async () => {
  for (const cancel of ['close', 'hidden', 'none'] as const) {
    let valid = true;
    const resumed = deferred<void>();
    let measured = bounds;
    let created = 0;
    const f = fixture({ platform: 'darwin', validateTarget: () => valid,
      createSurface: async (_owner, rect) => {
        created++; measured = rect;
        return { setBounds() {}, async start() { if (created === 2) resumed.resolve(); }, async state() { return 'live'; }, destroy() {} };
      },
    });
    await f.preview.start(f.owner, 'task', 'ui', bounds);
    valid = false; await f.preview.check();
    const moved = { ...bounds, y: 80 };
    f.preview.updateBounds(f.owner, 'ui', moved);
    if (cancel === 'close') f.preview.stop(f.owner, 'ui');
    if (cancel === 'hidden') f.preview.updateBounds(f.owner, 'ui', { ...bounds, width: 0 });
    valid = true; f.replace({ ...target, leaseId: 'fresh' });
    if (cancel === 'none') {
      await resumed.promise;
      assert.deepEqual(measured, moved);
    }
    await f.preview.check();
    assert.equal(created, cancel === 'none' ? 2 : 1);
    f.preview.dispose();
  }
});

for (const result of ['permission_denied', 'capture_failed', 'destroyed-after-identity-loss'] as const) {
  test(`${result} during a pending state read preserves the reason for ending or resuming preview`, async () => {
    const reading = deferred<void>();
    const answer = deferred<string>();
    const resumed = deferred<void>();
    let valid = true, created = 0;
    const f = fixture({ platform: 'darwin', validateTarget: () => valid,
      createSurface: async () => {
        const index = ++created;
        return { setBounds() {}, async start() { if (index === 2) resumed.resolve(); },
          state() { if (index === 1) { reading.resolve(); return answer.promise; } return Promise.resolve('live'); }, destroy() {} };
      },
    });
    await f.preview.start(f.owner, 'task', 'ui', bounds);
    const checking = f.preview.check();
    await reading.promise;
    valid = false;
    if (result === 'destroyed-after-identity-loss') answer.reject(new Error('child destroyed'));
    else answer.resolve(result);
    await checking;
    assert.equal(f.changes.at(-1)?.state, result === 'destroyed-after-identity-loss' ? 'waiting' : 'unavailable');
    valid = true;
    f.replace({ ...target, leaseId: 'fresh' });
    if (result === 'destroyed-after-identity-loss') await resumed.promise;
    await f.preview.check();
    assert.equal(created, result === 'destroyed-after-identity-loss' ? 2 : 1);
    f.preview.dispose();
  });
}

for (const state of ['capturing', 'waiting'] as const) {
  test(`OS permission denial ends a ${state} request even when identity also fails`, async () => {
    let denied = false, valid = true;
    let authorize: (() => boolean) | undefined;
    let created = 0;
    const f = fixture({ platform: 'darwin', permissionDenied: () => denied, validateTarget: () => valid,
      createSurface: async (_owner, _bounds, _source, allowed) => {
        authorize = allowed; created++;
        return { setBounds() {}, async start() {}, async state() { return 'live'; }, destroy() {} };
      },
    });
    await f.preview.start(f.owner, 'task', 'ui', bounds);
    await f.preview.check();
    valid = false;
    if (state === 'waiting') await f.preview.check();
    denied = true;
    if (state === 'capturing') assert.equal(authorize!(), false);
    else await f.preview.check();
    assert.deepEqual(f.changes.at(-1), { leaseId: 'ui', state: 'unavailable', reason: 'permission_denied' });
    denied = false; valid = true;
    f.replace({ ...target, leaseId: 'fresh' });
    await f.preview.check();
    assert.equal(created, 1, 'restoring permission cannot restore a cancelled preview request');
    await f.preview.start(f.owner, 'task', 'explicit-new-request', bounds);
    assert.equal(created, 2, 'a new user request can preview after permission is restored');
    f.preview.dispose();
  });
}

test('closing while source selection waits cannot create a late view', async () => {
  let resolve!: (value: Array<{ id: string; name: string }>) => void;
  const sources = new Promise<Array<{ id: string; name: string }>>((next) => { resolve = next; });
  const f = fixture({ sources: () => sources });
  const opening = f.preview.start(f.owner, 'task', 'lease', bounds);
  f.preview.stop(f.owner, 'lease');
  resolve([{ id: 'window:44:0', name: 'Fixture' }]);
  assert.equal((await opening).state, 'stopped');
  assert.equal(f.created(), 0);
});

test('a stalled capture setup times out and cannot resurrect its late source result', async () => {
  let now = 0;
  let resolve!: (value: Array<{ id: string; name: string }>) => void;
  const sources = new Promise<Array<{ id: string; name: string }>>((next) => { resolve = next; });
  const f = fixture({ sources: () => sources, now: () => now });
  const opening = f.preview.start(f.owner, 'task', 'lease', bounds);
  now = 30_001; await f.preview.check();
  assert.equal(f.changes.at(-1)?.reason, 'capture_failed');
  resolve([{ id: 'window:44:0', name: 'Fixture' }]);
  assert.equal((await opening).state, 'unavailable');
  assert.equal(f.created(), 0);
});

test('closing during child document loading destroys the late surface', async () => {
  let resolve!: (value: PreviewSurface) => void;
  const surface = new Promise<PreviewSurface>((next) => { resolve = next; });
  const f = fixture({ createSurface: () => surface });
  const opening = f.preview.start(f.owner, 'task', 'lease', bounds);
  await Promise.resolve(); await Promise.resolve();
  f.preview.stop(f.owner, 'lease');
  let destroyed = 0;
  resolve({ setBounds() {}, async start() {}, async state() { return 'live'; }, destroy() { destroyed++; } });
  assert.equal((await opening).state, 'stopped');
  assert.equal(destroyed, 1);
});

test('missing native authority and unsupported platforms never enumerate capture sources', async () => {
  for (const input of [{ platform: 'linux' as const }, { validateTarget: () => false }]) {
    let listed = false;
    const f = fixture({ ...input, sources: async () => { listed = true; return []; } });
    assert.equal((await f.preview.start(f.owner, 'task', 'lease', bounds)).state, 'unavailable');
    assert.equal(listed, false);
  }
});

test('hidden, locked, stopped tracks and invalid slot each terminate the actual capturer', async () => {
  let visible = true;
  const f = fixture({ visible: () => visible });
  await f.preview.start(f.owner, 'task', 'lease', bounds);
  visible = false; await f.preview.check();
  assert.equal(f.destroyed(), 1);
  visible = true; await f.preview.start(f.owner, 'task', 'lease2', bounds);
  f.preview.locked();
  assert.equal(f.destroyed(), 2);
  await f.preview.start(f.owner, 'task', 'lease3', bounds);
  f.preview.updateBounds(f.owner, 'lease3', { ...bounds, width: 0 });
  assert.equal(f.destroyed(), 3);
});

test('stale close cannot revoke a replacement preview, and native failure is explicit', async () => {
  const f = fixture();
  await f.preview.start(f.owner, 'task', 'old', bounds);
  await f.preview.start(f.owner, 'task', 'new', bounds);
  f.preview.stop(f.owner, 'old');
  assert.equal(f.destroyed(), 1);
  f.state('permission_denied'); await f.preview.check();
  assert.equal(f.destroyed(), 2);
  assert.equal(f.changes.at(-1)?.reason, 'permission_denied');
});

for (const reason of ['target_changed', 'locked', 'hidden'] as const) {
  test(`a late first-frame result cannot publish live after ${reason}`, async () => {
    const reading = deferred<void>();
    const result = deferred<string>();
    let revoked = false;
    let destroyed = 0;
    const f = fixture({
      validateTarget: () => !(revoked && reason === 'target_changed'),
      locked: () => revoked && reason === 'locked',
      visible: () => !(revoked && reason === 'hidden'),
      createSurface: async () => ({
        setBounds() {}, async start() {},
        state() { reading.resolve(); return result.promise; },
        destroy() { destroyed++; },
      }),
    });
    try {
      await f.preview.start(f.owner, 'task', 'lease', bounds);
      const checking = f.preview.check();
      await reading.promise;
      revoked = true;
      result.resolve('live');
      await checking;
      assert.equal(f.changes.some((change) => change.state === 'live'), false);
      assert.equal(f.changes.at(-1)?.reason, reason);
      assert.equal(destroyed, 1);
    } finally { f.preview.dispose(); }
  });
}
