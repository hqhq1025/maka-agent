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
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { CuRunResult } from '@maka/runtime/computer-use-types';
import { COMPUTER_USE_PRESENTATION_CHANNELS as channels } from '../../shared/computer-use-presentation-channels.js';
import type { ComputerUsePresentation } from '../../shared/computer-use-presentation.js';
import { desktopSessionResourceKey } from '../../shared/runtime-host-identity.js';
import { createComputerUsePresentationFeed } from '../computer-use/presentation-feed.js';
import { registerComputerUsePresentationIpc } from '../computer-use/presentation-ipc-main.js';
import { createComputerUsePresentationBridge } from '../../preload/computer-use-presentation.js';

const scope = { hostId: 'host-a', targetEpoch: 'epoch-a' };
const key = (id = 'task-a') => desktopSessionResourceKey({ ...scope, sessionId: id });
const context = (id = 'task-a', toolCallId = 'call-a') => ({ sessionId: key(id), toolCallId, targetWindowId: 7 });
const action = { type: 'click_element' as const };
const result: CuRunResult = {
  outcome: { ok: true, tier: 'ax', evidence: { effect: 'confirmed', reason: 'delivery:background' } },
  observation: {
    observationId: 'private-id', appId: 'Text Editor', pid: 20, windowId: 7,
    accessibilityText: 'private application content', elements: [], capturedAt: 99,
    screenshot: { base64: 'dGVzdA==', mimeType: 'image/png', widthPx: 64, heightPx: 32 },
  },
};

test('presentation isolates tasks, exposes only authorized result fields, and releases unsubscribed frames', async () => {
  const feed = createComputerUsePresentationFeed(() => 100);
  const changes: Array<ComputerUsePresentation | null> = [];
  const release = feed.subscribe(key(), (value) => changes.push(value));
  const hook = feed.wrap({ onActionBegin() {} });
  assert.equal(feed.read(key()), null);
  const other = context('task-b');
  hook.onActionBegin(action, other);
  await hook.onActionEnd?.(action, result, other);
  assert.equal(changes.length, 0);
  assert.equal(feed.read(key('task-b'))?.frame, undefined);
  const active = context();
  hook.onActionBegin(action, active);
  assert.equal(feed.read(key())?.frame, undefined);
  assert.equal(feed.read(key())?.outcome, undefined);
  await hook.onActionEnd?.(action, result, active);
  const settled = feed.read(key())!;
  assert.deepEqual(settled.outcome, { ok: true, effect: 'confirmed', delivery: 'background' });
  assert.equal(settled.frame?.capturedAt, 99);
  assert.ok(!JSON.stringify(settled).includes('private'));
  assert.ok(changes[1]!.revision > changes[0]!.revision);
  release();
  assert.equal(feed.read(key())?.frame, undefined);
});

test('stop keeps an active call stopping until settlement and never restores its frame', async () => {
  const feed = createComputerUsePresentationFeed();
  feed.subscribe(key(), () => {});
  const hook = feed.wrap({ onActionBegin() {} });
  const active = context();
  hook.onActionBegin(action, active);
  feed.stopping(key());
  assert.equal(feed.read(key())?.state, 'stopping');
  // The real stop route calls the native capability release before awaiting
  // Host cancellation, while the dispatched native call can still be running.
  feed.release(key());
  assert.equal(feed.read(key())?.state, 'stopping');
  feed.complete(key());
  assert.equal(feed.read(key())?.state, 'stopping');
  await hook.onActionEnd?.(action, result, active);
  assert.equal(feed.read(key())?.state, 'stopped');
  assert.equal(feed.read(key())?.frame, undefined);
  const next = context('task-a', 'next-call');
  hook.onActionBegin(action, next);
  await hook.onActionEnd?.(action, result, next);
  assert.equal(feed.read(key())?.state, 'settled');
  assert.ok(feed.read(key())?.frame);
});

test('accepted read-only captures populate the preview and target changes clear old content', async () => {
  const feed = createComputerUsePresentationFeed();
  const release = feed.subscribe(key(), () => {});
  const hook = feed.wrap({ onActionBegin() {} });
  await hook.onObservation?.(result.observation!, context());
  assert.equal(feed.read(key())?.appName, 'Text Editor');
  assert.ok(feed.read(key())?.frame);
  const { screenshot: _screenshot, ...textOnly } = result.observation!;
  await hook.onObservation?.(textOnly, context('task-a', 'text-only'));
  assert.equal(feed.read(key())?.frame?.capturedAt, 99);
  feed.complete(key());
  assert.equal(feed.read(key())?.state, 'completed');
  assert.ok(feed.read(key())?.frame);
  hook.onActionBegin(action, { ...context('task-a', 'new-target'), targetWindowId: 8 });
  assert.equal(feed.read(key())?.appName, undefined);
  assert.equal(feed.read(key())?.frame, undefined);
  release();
});

test('retirement and shutdown discard pending results and notify current subscribers', async () => {
  let hostActive = true;
  const feed = createComputerUsePresentationFeed(Date.now, () => hostActive);
  const changes: Array<ComputerUsePresentation | null> = [];
  feed.subscribe(key(), (value) => changes.push(value));
  const hook = feed.wrap({ onActionBegin() {} });
  const active = context();
  hook.onActionBegin(action, active);
  hostActive = false;
  feed.retire(scope);
  await hook.onActionEnd?.(action, result, active);
  // Native capability shutdown can await other domains after Host retirement;
  // a capture that settles in that interval cannot recreate a preview.
  await hook.onObservation?.(result.observation!, context('task-a', 'late-observe'));
  assert.equal(feed.read(key()), null);
  assert.equal(changes.at(-1), null);
  hostActive = true;
  const next = context('task-a', 'next-call');
  hook.onActionBegin(action, next);
  feed.dispose();
  await hook.onActionEnd?.(action, result, next);
  hook.onActionBegin(action, context('task-b'));
  assert.equal(feed.read(key()), null);
  assert.equal(feed.read(key('task-b')), null);
});

class Renderer extends EventEmitter {
  readonly mainFrame = {};
  readonly deliveries: unknown[][] = [];
  isDestroyed() { return false; }
  send(...values: unknown[]) { this.deliveries.push(values); }
}

test('IPC validates renderer and epoch, directs frames only to subscribers, and cleans navigation', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipcMain = {
    handle(channel: string, handler: (...args: any[]) => any) { handlers.set(channel, handler); },
    removeHandler(channel: string) { handlers.delete(channel); },
  } as Pick<IpcMain, 'handle' | 'removeHandler'>;
  const feed = createComputerUsePresentationFeed();
  const renderer = new Renderer();
  const stranger = new Renderer();
  const event = (sender: Renderer): IpcMainInvokeEvent => ({ sender: sender as unknown as WebContents, senderFrame: sender.mainFrame }) as IpcMainInvokeEvent;
  const stopped: string[] = [];
  const ipc = registerComputerUsePresentationIpc({ ipcMain, feed,
    ownsRenderer: (sender) => sender === renderer as unknown as WebContents,
    isHostActive: (target) => target.hostId === scope.hostId && target.targetEpoch === scope.targetEpoch,
    stop: async (sessionId) => { stopped.push(sessionId); },
  });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event(renderer), ...args);
  assert.throws(() => handlers.get(channels.read)!(event(stranger), scope, 'task-a'), /trusted/);
  assert.throws(() => invoke(channels.read, { ...scope, targetEpoch: 'old' }, 'task-a'), /unavailable/);
  assert.throws(() => handlers.get(channels.read)!({ ...event(renderer), senderFrame: {} }, scope, 'task-a'), /trusted/);
  invoke(channels.subscribe, scope, 'task-a', 'token');
  const hook = feed.wrap({ onActionBegin() {} });
  const other = context('task-b');
  hook.onActionBegin(action, other);
  await hook.onActionEnd?.(action, result, other);
  assert.equal(renderer.deliveries.length, 0);
  const active = context();
  hook.onActionBegin(action, active);
  await hook.onActionEnd?.(action, result, active);
  assert.equal(renderer.deliveries.length, 2);
  assert.equal(renderer.deliveries[1]?.[1], 'token');
  await invoke(channels.stop, scope, 'task-a');
  assert.deepEqual(stopped, [key()]);
  renderer.emit('did-start-navigation', {}, 'app://reload', false, true);
  assert.equal(feed.read(key())?.frame, undefined);
  hook.onActionBegin(action, context('task-a', 'next-call'));
  assert.equal(renderer.deliveries.length, 2);
  ipc.dispose();
  assert.equal(handlers.size, 0);
});

test('preload close during subscription registration removes the eventual subscriber', async () => {
  let resolveOpen!: (value: unknown) => void;
  const opening = new Promise((resolve) => { resolveOpen = resolve; });
  const invoked: string[] = [];
  const renderer = new EventEmitter();
  const bridge = createComputerUsePresentationBridge({
    ipc: renderer as any,
    sessionRef: async () => ({ scope, sessionId: 'task-a' }),
    invoke: async (channel) => { invoked.push(channel); return channel === channels.subscribe ? opening : undefined; },
  });
  const values: unknown[] = [];
  const release = bridge.subscribe('["host-a","task-a"]', (value) => values.push(value));
  await Promise.resolve();
  release();
  assert.equal(renderer.listenerCount(channels.changed), 0);
  resolveOpen(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(invoked, [channels.subscribe, channels.unsubscribe]);
  assert.equal(values.length, 0);
});

test('preload rebinds a visible task on Host replacement and rejects old-epoch frames', async () => {
  const renderer = new EventEmitter();
  let currentScope = scope;
  const opened: Array<{ token: string; scope: typeof scope }> = [];
  const closed: string[] = [];
  const bridge = createComputerUsePresentationBridge({
    ipc: renderer as any,
    sessionRef: async () => ({ scope: currentScope, sessionId: 'task-a' }),
    invoke: async (channel, target, _sessionId, token) => {
      if (channel === channels.subscribe) opened.push({ token: token as string, scope: target as typeof scope });
      if (channel === channels.unsubscribe) closed.push(target as string);
      return null;
    },
  });
  const values: Array<ComputerUsePresentation | null> = [];
  const release = bridge.subscribe('["host-a","task-a"]', (value) => values.push(value));
  await new Promise<void>((resolve) => setImmediate(resolve));
  currentScope = { ...scope, targetEpoch: 'replacement' };
  renderer.emit('runtime-host-profiles:changed', {}, { hostId: scope.hostId, readiness: 'ready' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opened.length, 2);
  assert.deepEqual(closed, [opened[0]!.token]);
  const previousCount = values.length;
  renderer.emit(channels.changed, {}, opened[0]!.token, { sessionId: key(), revision: 1, updatedAt: 0, state: 'settled' });
  assert.equal(values.length, previousCount);
  renderer.emit(channels.changed, {}, opened[1]!.token, {
    sessionId: desktopSessionResourceKey({ ...currentScope, sessionId: 'task-a' }), revision: 2, updatedAt: 0, state: 'settled',
  });
  assert.equal(values.at(-1)?.sessionId, '["host-a","task-a"]');
  assert.equal(values.at(-1)?.revision, 2);
  release();
  assert.equal(renderer.listenerCount('runtime-host-profiles:changed'), 0);
});

test('a duplicate ready event cannot strand a failed subscription for the same epoch', async () => {
  const renderer = new EventEmitter();
  let rejectFirst!: (reason: Error) => void;
  const first = new Promise<unknown>((_resolve, reject) => { rejectFirst = reject; });
  let attempts = 0;
  const bridge = createComputerUsePresentationBridge({
    ipc: renderer as any,
    sessionRef: async () => ({ scope, sessionId: 'task-a' }),
    invoke: async (channel) => channel === channels.subscribe && ++attempts === 1 ? first : null,
  });
  const release = bridge.subscribe('["host-a","task-a"]', () => {});
  await Promise.resolve();
  renderer.emit('runtime-host-profiles:changed', {}, { hostId: scope.hostId, readiness: 'ready' });
  await Promise.resolve();
  rejectFirst(new Error('Temporary registration failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  renderer.emit('runtime-host-profiles:changed', {}, { hostId: scope.hostId, readiness: 'ready' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  release();
});
