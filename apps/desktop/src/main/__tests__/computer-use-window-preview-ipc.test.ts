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
import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent, IpcRenderer, WebContents, View } from 'electron';
import { COMPUTER_USE_PREVIEW_CHANNELS as channels } from '../../shared/computer-use-preview-channels.js';
import { registerComputerUsePreviewIpc } from '../computer-use/window-preview-ipc.js';
import { createComputerUsePreviewBridge } from '../../preload/computer-use-preview.js';
import { resolveOverlayAssetDir } from '../overlay-assets.js';

test('preview assets resolve identically from separate tsc modules and bundled development main', () => {
  assert.equal(resolveOverlayAssetDir('file:///workspace/apps/desktop/dist/main/computer-use/window-preview-ipc.js'), '/workspace/apps/desktop/dist/overlay');
  assert.equal(resolveOverlayAssetDir('file:///workspace/apps/desktop/dist/main/main.js'), '/workspace/apps/desktop/dist/overlay');
});

test('preview IPC requires an owned top frame and current Host, even before any capture source request', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {}, send() {} }) as unknown as WebContents;
  const foreign = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {}, send() {} }) as unknown as WebContents;
  let active = true;
  const registration = registerComputerUsePreviewIpc({
    ipcMain: {
      handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) { handlers.set(channel, handler); },
      removeHandler(channel: string) { handlers.delete(channel); },
    } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>,
    parent: (sender) => sender === owner ? {} as View : undefined,
    visible: () => true, isHostActive: () => active,
    target: () => null, subscribeTarget: () => () => {}, validateTarget: () => false,
    locked: () => false, subscribeLock: () => () => {},
  });
  const event = (sender: WebContents, frame = sender.mainFrame) => ({ sender, senderFrame: frame }) as IpcMainInvokeEvent;
  const invoke = handlers.get(channels.start)!;
  const args = [{ hostId: 'local', targetEpoch: 'epoch' }, 'task', 'lease', { x: 0, y: 0, width: 100, height: 100 }, 1];
  assert.throws(() => invoke(event(foreign), ...args), /trusted/);
  assert.throws(() => invoke(event(owner, {} as WebContents['mainFrame']), ...args), /trusted/);
  active = false;
  assert.throws(() => invoke(event(owner), ...args), /unavailable/);
  active = true;
  const result = await invoke(event(owner), ...args) as { state: string };
  assert.equal(result.state, 'unavailable');
  handlers.get(channels.stop)!(event(owner), 'lease', 2);
  const stale = await invoke(event(owner), ...args) as { state: string };
  assert.equal(stale.state, 'stopped');
  registration.dispose();
  assert.equal(handlers.size, 0);
});

test('preview preload forwards only scope/task/lease/bounds, and subscriptions remove exact listener', async () => {
  const emitter = new EventEmitter();
  const calls: unknown[][] = [];
  const ref = { scope: { hostId: 'local', targetEpoch: 'epoch' }, sessionId: 'task' };
  const bridge = createComputerUsePreviewBridge({
    ipc: { on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) } as unknown as Pick<IpcRenderer, 'on' | 'removeListener'>,
    sessionRef: async () => ref,
    invoke: async (...args) => { calls.push(args); return { leaseId: 'lease', state: 'starting' }; },
  });
  const bounds = { x: 10, y: 10, width: 200, height: 100 };
  await bridge.start('client-task', 'lease', bounds);
  assert.deepEqual(calls[0], [channels.start, ref.scope, 'task', 'lease', bounds, 1]);
  const changes: unknown[] = [];
  const release = bridge.subscribe((value) => changes.push(value));
  emitter.emit(channels.changed, {}, { leaseId: 'lease', state: 'live' });
  release();
  emitter.emit(channels.changed, {}, { leaseId: 'lease', state: 'stopped' });
  assert.equal(changes.length, 1);
  assert.equal(emitter.listenerCount(channels.changed), 0);
});

test('close during sessionRef lookup suppresses late start IPC and an older lookup cannot replace the next lease', async () => {
  const emitter = new EventEmitter();
  const calls: unknown[][] = [];
  const resolveRefs: Array<(value: { scope: { hostId: string; targetEpoch: string }; sessionId: string }) => void> = [];
  const bridge = createComputerUsePreviewBridge({
    ipc: emitter as unknown as Pick<IpcRenderer, 'on' | 'removeListener'>,
    sessionRef: () => new Promise((resolve) => resolveRefs.push(resolve)),
    invoke: async (...args) => { calls.push(args); return { leaseId: args[3], state: 'starting' }; },
  });
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  const ref = { scope: { hostId: 'local', targetEpoch: 'epoch' }, sessionId: 'task' };
  const abandoned = bridge.start('task', 'abandoned', bounds);
  await bridge.stop('abandoned');
  resolveRefs[0](ref);
  assert.equal((await abandoned).state, 'stopped');
  assert.deepEqual(calls, [[channels.stop, 'abandoned', 2]]);
  const old = bridge.start('task', 'old', bounds);
  const current = bridge.start('task', 'current', bounds);
  resolveRefs[2](ref); await current;
  resolveRefs[1](ref);
  assert.equal((await old).state, 'stopped');
  assert.equal(calls.filter((call) => call[0] === channels.start).length, 1);
  assert.equal(calls.at(-1)?.[3], 'current');
});
