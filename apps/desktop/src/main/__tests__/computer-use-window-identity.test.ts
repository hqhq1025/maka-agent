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
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CuObservation } from '@maka/runtime/computer-use-types';
import { createComputerUsePresentationFeed } from '../computer-use/presentation-feed.js';
import { createComputerUseWindowPreview } from '../computer-use/window-preview.js';
import { createComputerUseWindowIdentity, resolveDesktopWindowIdentityPath, type DesktopWindowIdentityNative } from '../computer-use/window-identity.js';
import { desktopSessionResourceKey } from '../../shared/runtime-host-identity.js';
import { deferred } from '@maka/core/test-only/async-primitives';

function iconPng(width = 32, height = 32): Buffer {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAM0lEQVR4nO3OQQEAMAjEsGPKJmti8TJk8EkNNHVf/yx2NucAAAAAAAAAAAAAAAAAAABJMpFFAtN7t2psAAAAAElFTkSuQmCC', 'base64');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function fixture(platform: NodeJS.Platform = 'darwin') {
  const live = new Map<string, { pid: number; windowId: number; instance: number }>();
  let instance = 1;
  const releases: string[] = [];
  let acquired = 0;
  const native: DesktopWindowIdentityNative = {
    acquire(pid, windowId) { const id = randomUUID(); acquired++; live.set(id, { pid, windowId, instance }); return id; },
    validate(id, pid, windowId) { const entry = live.get(id); return entry?.pid === pid && entry.windowId === windowId && entry.instance === instance; },
    release(id) { releases.push(id); live.delete(id); },
    applicationIcon(id, pid, windowId) { return this.validate(id, pid, windowId) ? iconPng() : undefined; },
  };
  const identity = createComputerUseWindowIdentity({ platform, loadNative: () => native });
  const sessionId = desktopSessionResourceKey({ hostId: 'host', targetEpoch: 'epoch', sessionId: 'task' });
  const target = { pid: 20, windowId: 7 };
  return { identity, native, sessionId, target, releases, acquired: () => acquired, replace: () => { instance++; } };
}

test('identity addon uses the stable app root for both tsc and bundled main layouts', () => {
  assert.equal(resolveDesktopWindowIdentityPath({ isPackaged: false, resourcesPath: '/unused',
    appPath: '/repo/maka-agent/apps/desktop',
  }), '/repo/maka-agent/native/desktop-window-identity/build/maka_desktop_window_identity.node');
  assert.equal(resolveDesktopWindowIdentityPath({ isPackaged: true, resourcesPath: '/Maka.app/Contents/Resources', appPath: '/Maka.app/Contents/Resources/app.asar' }),
    '/Maka.app/Contents/Resources/desktop-window-identity/maka_desktop_window_identity.node');
});

test('application artwork requires the owned window and late results cannot replace a changed target', async () => {
  for (const change of ['target', 'stop', 'retire', 'replace', 'lock', 'none'] as const) {
    const f = fixture();
    const icon = deferred<string | undefined>();
    const targets: unknown[] = [];
    const feed = createComputerUsePresentationFeed(Date.now, () => true, {
      identity: f.identity, mayPreview: () => true,
      applicationIcon: async (target) => { targets.push(target); return icon.promise; },
    });
    const hook = feed.wrap({ onActionBegin() {} });
    const lease = f.identity.acquire(f.target, f)!;
    const observation: CuObservation = { observationId: 'id', appId: 'Editor', pid: 20, windowId: 7, elements: [], presentationTargetLease: lease };
    await hook.onObservation?.(observation, { sessionId: f.sessionId, toolCallId: 'observe' });
    const target = feed.previewTarget(f.sessionId)!;
    assert.equal(f.identity.applicationIcon({ ...target, sessionId: 'other' }), undefined);
    assert.equal(f.identity.applicationIcon({ ...target, pid: 21 }), undefined);
    assert.deepEqual(targets, [target]);
    if (change === 'target') hook.onActionBegin({ type: 'click_element' }, { sessionId: f.sessionId, toolCallId: 'next', targetWindowId: 8 });
    if (change === 'stop') feed.stopping(f.sessionId);
    if (change === 'retire') feed.retire({ hostId: 'host', targetEpoch: 'epoch' });
    if (change === 'replace') f.replace();
    if (change === 'lock') feed.suspendPreview();
    icon.resolve('data:image/png;base64,aWNvbg==');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(feed.read(f.sessionId)?.appIconDataUrl, change === 'none' ? 'data:image/png;base64,aWNvbg==' : undefined, change);
    assert.ok(!JSON.stringify(feed.read(f.sessionId)).includes(lease), 'native identity remains in main');
    feed.dispose();
  }
});

test('native application artwork requires adopted identity and validates the window again after reading', () => {
  const f = fixture();
  const leaseId = f.identity.acquire(f.target, f)!;
  const target = { ...f.target, sessionId: f.sessionId, appName: 'Editor', revision: 1, leaseId };
  let reads = 0;
  f.native.applicationIcon = () => { reads++; return iconPng(); };
  assert.equal(f.identity.applicationIcon(target), undefined);
  assert.equal(reads, 0, 'unpublished observations cannot read application artwork');
  assert.equal(f.identity.adopt(leaseId, f.sessionId, 20, 7), true);
  assert.equal(f.identity.applicationIcon(target), `data:image/png;base64,${iconPng().toString('base64')}`);
  f.native.applicationIcon = () => { reads++; f.replace(); return iconPng(); };
  assert.equal(f.identity.applicationIcon(target), undefined, 'replacement during the native read cannot publish old artwork');
  assert.equal(reads, 2);
  f.identity.dispose();
});

test('application artwork rejects absent, malformed, oversized, or non-icon native output', () => {
  for (const bytes of [undefined, Buffer.alloc(0), Buffer.from('not a PNG'), iconPng(1280, 720),
    Buffer.concat([iconPng(), Buffer.alloc(64 * 1024)])]) {
    const f = fixture();
    const leaseId = f.identity.acquire(f.target, f)!;
    f.identity.adopt(leaseId, f.sessionId, 20, 7);
    f.native.applicationIcon = () => bytes;
    assert.equal(f.identity.applicationIcon({ ...f.target, sessionId: f.sessionId, appName: 'Editor', revision: 1, leaseId }), undefined);
    f.identity.dispose();
  }
});

test('stable accepted identity survives a failed capture but releases on task teardown', () => {
  const f = fixture();
  const id = f.identity.acquire(f.target, f)!;
  assert.ok(f.identity.adopt(id, f.sessionId, 20, 7));
  assert.equal(f.identity.acquire(f.target, f), id);
  f.identity.release(id);
  assert.equal(f.identity.validate(id, 20, 7), true);
  assert.equal(f.acquired(), 1, 'observations of the same live window do not restart its stream');
  f.identity.releaseSession(f.sessionId);
  assert.equal(f.identity.validate(id, 20, 7), false);
  assert.deepEqual(f.releases, [id]);
});

test('foreground validation refuses focus changes without releasing a valid background target', () => {
  const f = fixture('win32');
  let foreground = true;
  f.native.validateForeground = (id, pid, windowId) => foreground && f.native.validate(id, pid, windowId);
  const lease = f.identity.acquire(f.target, f)!;
  f.identity.adopt(lease, f.sessionId, 20, 7);
  assert.equal(f.identity.validateForeground(lease, 20, 7), true);
  foreground = false;
  assert.equal(f.identity.validateForeground(lease, 20, 7), false);
  assert.equal(f.identity.validate(lease, 20, 7), true);
  assert.equal(f.identity.acquire(f.target, f), lease);
  assert.deepEqual(f.releases, []);
  foreground = true;
  assert.equal(f.identity.validateForeground(lease, 20, 7), true);
  f.replace();
  assert.equal(f.identity.validateForeground(lease, 20, 7), false);
  f.identity.dispose();
});

test('foreground validation requires the owned binding and an available native check', () => {
  const f = fixture('win32');
  const lease = f.identity.acquire(f.target, f)!;
  assert.equal(f.identity.validateForeground(lease, 20, 7), false);
  f.native.validateForeground = () => { throw new Error('unavailable'); };
  assert.equal(f.identity.validateForeground(lease, 20, 7), false);
  f.native.validateForeground = () => true;
  assert.equal(f.identity.validateForeground(lease, 21, 7), false);
  assert.equal(f.identity.validateForeground(lease, 20, 8), false);
  f.identity.releaseSession(f.sessionId);
  assert.equal(f.identity.validateForeground(lease, 20, 7), false);
  f.identity.dispose();
});

test('a duration wait keeps the current application and live preview until a real invalidation', async () => {
  for (const boundary of ['none', 'stop', 'lock', 'target', 'unbound-input', 'replace'] as const) {
    const f = fixture();
    const feed = createComputerUsePresentationFeed(Date.now, () => true, { identity: f.identity, mayPreview: () => true });
    feed.subscribe(f.sessionId, () => {});
    const hook = feed.wrap({ onActionBegin() {} });
    const lease = f.identity.acquire(f.target, f)!;
    const observation: CuObservation = {
      observationId: 'before', appId: 'Editor', ...f.target, elements: [], presentationTargetLease: lease,
      screenshot: { base64: iconPng().toString('base64'), mimeType: 'image/png', widthPx: 32, heightPx: 32 },
    };
    const context = { sessionId: f.sessionId, toolCallId: 'wait' };
    await hook.onObservation?.(observation, context);
    let created = 0, destroyed = 0;
    const owner = {};
    const preview = createComputerUseWindowPreview<object>({
      platform: 'darwin', target: (key) => feed.previewTarget(key),
      subscribeTarget: (key, listener) => feed.subscribePreviewTarget(key, listener),
      validateTarget: (target) => f.identity.validate(target.leaseId, target.pid, target.windowId),
      visible: () => true, locked: () => false, sources: async () => [],
      createSurface: async () => {
        created++;
        return { setBounds() {}, async start() {}, async state() { return 'live' as const; }, destroy() { destroyed++; } };
      },
      changed() {},
    });
    await preview.start(owner, f.sessionId, 'view', { x: 0, y: 0, width: 320, height: 200 });
    await preview.check();
    const wait = { type: 'wait' as const, durationMs: 8000 };
    hook.onActionBegin(wait, context);
    await preview.check();
    assert.equal(destroyed, 0, 'waiting cannot mean the assistant switched windows');
    assert.equal(feed.previewTarget(f.sessionId)?.leaseId, lease);
    assert.equal(feed.read(f.sessionId)?.appName, 'Editor');
    assert.ok(feed.read(f.sessionId)?.frame);
    if (boundary === 'stop') feed.stopping(f.sessionId);
    if (boundary === 'lock') feed.suspendPreview();
    if (boundary === 'target') hook.onActionBegin({ type: 'click_element' }, { ...context, toolCallId: 'next', targetWindowId: 8 });
    if (boundary === 'unbound-input') hook.onActionBegin({ type: 'click_element' }, { ...context, toolCallId: 'next' });
    if (boundary === 'replace') f.replace();
    await hook.onActionEnd?.(wait, { outcome: { ok: true, tier: 'ax' } }, context);
    await preview.check();
    assert.equal(destroyed, boundary === 'none' ? 0 : 1, boundary);
    if (boundary === 'none') {
      assert.equal(feed.read(f.sessionId)?.windowId, 7);
      assert.ok(feed.read(f.sessionId)?.frame);
      await hook.onObservation?.({ ...observation, observationId: 'after' }, context);
      await preview.check();
      assert.equal(created, 1, 'a fresh observation reuses the same stream');
      assert.equal(destroyed, 0);
    }
    preview.dispose();
    feed.dispose();
  }
});

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform} accepted observations resume preview after a target change, but never after task teardown`, async () => {
    for (const boundary of ['target', 'identity', 'stop', 'complete', 'clear', 'release', 'lock', 'retire'] as const) {
      const f = fixture(platform);
      let unlocked = true;
      const feed = createComputerUsePresentationFeed(Date.now, () => true, { identity: f.identity, mayPreview: () => unlocked });
      const hook = feed.wrap({ onActionBegin() {} });
      const context = { sessionId: f.sessionId, toolCallId: 'observe' };
      const observe = async (windowId: number) => {
        const nativeTarget = { pid: 20, windowId };
        const lease = f.identity.acquire(nativeTarget, f)!;
        await hook.onObservation?.({ ...nativeTarget, observationId: lease, appId: 'Editor', elements: [], presentationTargetLease: lease }, context);
      };
      await observe(7);
      const owner = {};
      const captures: { windowId: number; authorize(): boolean; destroyed: boolean }[] = [];
      const resumed = deferred<void>();
      const statuses: string[] = [];
      const preview = createComputerUseWindowPreview<object>({
        platform, target: (key) => feed.previewTarget(key),
        subscribeTarget: (key, listener) => feed.subscribePreviewTarget(key, listener),
        validateTarget: (target) => f.identity.validate(target.leaseId, target.pid, target.windowId),
        visible: () => true, locked: () => !unlocked,
        sources: async () => [7, 8].map((id) => ({ id: `window:${id}:0`, name: 'Editor' })),
        createSurface: async (_owner, _bounds, _source, authorize, target) => {
          const capture = { windowId: target.windowId, authorize, destroyed: false };
          captures.push(capture);
          return { setBounds() {}, async start() { if (captures.length === 2) resumed.resolve(); },
            async state() { return 'live'; }, destroy() { capture.destroyed = true; } };
        },
        changed: (_owner, status) => statuses.push(status.state),
      });
      try {
        await preview.start(owner, f.sessionId, 'view', { x: 0, y: 0, width: 320, height: 200 });
        await preview.check();
        if (boundary === 'target') {
          const input = { ...context, toolCallId: 'input', targetWindowId: 8 };
          hook.onActionBegin({ type: 'click_element' }, input);
          await hook.onActionEnd?.({ type: 'click_element' }, undefined, input);
        } else if (boundary === 'identity') { f.replace(); await preview.check(); }
        else if (boundary === 'stop') feed.stopping(f.sessionId);
        else if (boundary === 'lock') { unlocked = false; feed.suspendPreview(); }
        else if (boundary === 'retire') feed.retire({ hostId: 'host', targetEpoch: 'epoch' });
        else feed[boundary](f.sessionId);
        assert.equal(captures[0]!.destroyed, true, boundary);
        assert.equal(captures[0]!.authorize(), false, boundary);
        unlocked = true;
        await observe(8);
        if (boundary === 'target' || boundary === 'identity') {
          await resumed.promise;
          await preview.check();
          assert.equal(captures.length, 2, boundary);
          assert.equal(captures[1]!.windowId, 8);
          assert.equal(captures[1]!.authorize(), true);
          assert.equal(captures[0]!.authorize(), false, 'a new target never revives the old surface');
          assert.equal(statuses.at(-1), 'live');
        } else {
          await preview.check();
          assert.equal(captures.length, 1, `${boundary} cancels the request even if a later turn observes a new target`);
          assert.equal(statuses.at(-1), 'stopped');
        }
      } finally { preview.dispose(); feed.dispose(); }
    }
  });
}

test('PID or window ID reuse cannot validate the retained instance and replacement adopts fresh identity', () => {
  const f = fixture();
  const old = f.identity.acquire(f.target, f)!;
  assert.ok(f.identity.adopt(old, f.sessionId, 20, 7));
  f.replace();
  assert.equal(f.identity.validate(old, 20, 7), false);
  const current = f.identity.acquire(f.target, f)!;
  assert.notEqual(current, old);
  assert.equal(f.identity.adopt(old, f.sessionId, 20, 7), false);
  assert.equal(f.identity.adopt(current, 'other-task', 20, 7), false);
  assert.equal(f.identity.adopt(current, f.sessionId, 21, 7), false);
  assert.equal(f.identity.adopt(current, f.sessionId, 20, 7), true);
});

test('failed unpublished acquisition and unavailable platforms never grant preview', () => {
  const f = fixture();
  const id = f.identity.acquire(f.target, f)!;
  f.identity.release(id);
  assert.equal(f.identity.validate(id, 20, 7), false);
  let loads = 0;
  const linux = createComputerUseWindowIdentity({ platform: 'linux', loadNative: () => { loads++; throw new Error('unavailable'); } });
  assert.equal(linux.acquire(f.target, f), undefined);
  assert.equal(loads, 0);
});

test('task cleanup releases a native capture whose Runtime admission never created a feed entry', () => {
  for (const cleanup of ['complete', 'clear', 'release', 'dispose', 'retire', 'lock'] as const) {
    const f = fixture();
    const lease = f.identity.acquire(f.target, f)!;
    const feed = createComputerUsePresentationFeed(Date.now, () => true, { identity: f.identity, mayPreview: () => true });
    if (cleanup === 'dispose') feed.dispose();
    else if (cleanup === 'retire') feed.retire({ hostId: 'host', targetEpoch: 'epoch' });
    else if (cleanup === 'lock') feed.suspendPreview();
    else feed[cleanup](f.sessionId);
    assert.equal(f.identity.validate(lease, 20, 7), false, cleanup);
    assert.deepEqual(f.releases, [lease]);
  }
});

test('preview target comes from accepted native lease, never window-only action metadata', async () => {
  const f = fixture();
  const feed = createComputerUsePresentationFeed(Date.now, () => true, { identity: f.identity, mayPreview: () => true });
  const hook = feed.wrap({ onActionBegin() {} });
  const updates: unknown[] = [];
  feed.subscribePreviewTarget(f.sessionId, (value) => updates.push(value));
  const context = { sessionId: f.sessionId, toolCallId: 'call', targetWindowId: 7 };
  hook.onActionBegin({ type: 'click_element' }, context);
  assert.equal(feed.previewTarget(f.sessionId), null);
  await hook.onActionEnd?.({ type: 'click_element' }, undefined, context);
  const lease = f.identity.acquire(f.target, f)!;
  const observation: CuObservation = { observationId: 'id', appId: 'Editor', pid: 20, windowId: 7, windowTitle: 'Document', elements: [], presentationTargetLease: lease };
  hook.onObservation?.(observation, context);
  const first = feed.previewTarget(f.sessionId)!;
  assert.deepEqual({ ...first, revision: 1 }, { sessionId: f.sessionId, revision: 1, pid: 20, windowId: 7, appName: 'Editor', windowTitle: 'Document', leaseId: lease });
  hook.onObservation?.({ ...observation, observationId: 'fresh' }, context);
  assert.equal(feed.previewTarget(f.sessionId)?.revision, first.revision);
  assert.ok(!JSON.stringify(feed.read(f.sessionId)).includes(lease), 'native lease stays outside renderer presentation');
  feed.stopping(f.sessionId);
  assert.equal(feed.previewTarget(f.sessionId), null);
  assert.equal(f.identity.validate(lease, 20, 7), false);
  hook.onObservation?.(observation, context);
  assert.equal(feed.previewTarget(f.sessionId), null, 'late observations cannot reacquire a released native lease');
  assert.equal(updates.at(-1), null);
});

test('complete, host retirement, and screen lock revoke live targets and block late frames', () => {
  for (const mode of ['complete', 'retire', 'lock'] as const) {
    const f = fixture(); let unlocked = true;
    const feed = createComputerUsePresentationFeed(Date.now, () => true, { identity: f.identity, mayPreview: () => unlocked });
    const hook = feed.wrap({ onActionBegin() {} });
    const lease = f.identity.acquire(f.target, f)!;
    const context = { sessionId: f.sessionId, toolCallId: 'call' };
    const observation: CuObservation = { observationId: 'id', appId: 'Editor', pid: 20, windowId: 7, elements: [], presentationTargetLease: lease };
    hook.onObservation?.(observation, context);
    assert.ok(feed.previewTarget(f.sessionId));
    if (mode === 'complete') feed.complete(f.sessionId);
    if (mode === 'retire') feed.retire({ hostId: 'host', targetEpoch: 'epoch' });
    if (mode === 'lock') { unlocked = false; feed.suspendPreview(); }
    assert.equal(feed.previewTarget(f.sessionId), null);
    assert.equal(f.identity.validate(lease, 20, 7), false);
    hook.onObservation?.(observation, context);
    assert.equal(feed.previewTarget(f.sessionId), null);
    if (mode === 'lock') {
      feed.subscribe(f.sessionId, () => {});
      hook.onObservation?.({ ...observation, screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 1, heightPx: 1 } }, context);
      assert.equal(feed.read(f.sessionId)?.frame, undefined, 'a late accepted result cannot restore pixels while locked');
    }
  }
});
