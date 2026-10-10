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

import type { IpcMain, IpcMainInvokeEvent, WebContents, View } from 'electron';
import { join } from 'node:path';
import { resolveOverlayAssetDir } from '../overlay-assets.js';
import { COMPUTER_USE_PREVIEW_CHANNELS as channels } from '../../shared/computer-use-preview-channels.js';
import { desktopSessionResourceKey, requireDesktopTargetScope, type DesktopTargetScope } from '../../shared/runtime-host-identity.js';
import type { ComputerUsePreviewBounds } from '../../shared/computer-use-preview.js';
import { createComputerUseWindowPreview, validPreviewBounds, type ComputerUsePreviewTarget } from './window-preview.js';
import type { ComputerUsePreviewTargetListener, ComputerUseWindowIdentity } from './window-identity.js';

export function registerComputerUsePreviewIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  parent(owner: WebContents): View | undefined;
  visible(owner: WebContents): boolean;
  isHostActive(scope: DesktopTargetScope): boolean;
  target(key: string): ComputerUsePreviewTarget | null;
  subscribeTarget(key: string, listener: ComputerUsePreviewTargetListener): () => void;
  validateTarget(target: ComputerUsePreviewTarget): boolean;
  permissionDenied?(): boolean;
  locked(): boolean;
  subscribeLock(listener: () => void): () => void;
  startNativeCapture?: ComputerUseWindowIdentity['startCapture'];
}) {
  const tracked = new Map<WebContents, () => void>();
  const generations = new Map<WebContents, number>();
  let disposed = false;
  // Electron is only imported on the installed production path; core lease tests run in Node.
  const load = async () => {
    const [{ desktopCapturer }, { createComputerUsePreviewSurface }] = await Promise.all([
      import('electron'), import('./window-preview-surface.js'),
    ]);
    return { desktopCapturer, createComputerUsePreviewSurface };
  };
  const preview = createComputerUseWindowPreview<WebContents>({
    platform: process.platform,
    target: deps.target, subscribeTarget: deps.subscribeTarget, validateTarget: deps.validateTarget,
    permissionDenied: deps.permissionDenied,
    locked: deps.locked, visible: deps.visible,
    sources: async () => (await load()).desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false,
    }),
    createSurface: async (owner, bounds, source, authorize, target) => {
      const parent = deps.parent(owner);
      if (!parent) throw new Error('Preview renderer is unavailable');
      return (await load()).createComputerUsePreviewSurface({
        owner, parent, bounds, source, authorize, target,
        startNativeCapture: deps.startNativeCapture,
        documentPath: join(resolveOverlayAssetDir(import.meta.url), 'computer-use-preview.html'),
      });
    },
    changed(owner, value) { if (!owner.isDestroyed()) owner.send(channels.changed, value); },
  });
  function identify(event: IpcMainInvokeEvent): WebContents {
    if (disposed || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !deps.parent(event.sender)) {
      throw new Error('Computer preview requires a trusted Desktop top frame');
    }
    const owner = event.sender;
    if (!tracked.has(owner)) {
      const navigated = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
        if (main) { preview.stop(owner); generations.delete(owner); }
      };
      const cleanup = () => {
        preview.stop(owner);
        generations.delete(owner);
        owner.off('destroyed', cleanup); owner.off('render-process-gone', cleanup);
        owner.off('did-start-navigation', navigated); tracked.delete(owner);
      };
      tracked.set(owner, cleanup);
      owner.once('destroyed', cleanup); owner.once('render-process-gone', cleanup);
      owner.on('did-start-navigation', navigated);
    }
    return owner;
  }
  function lease(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('Invalid preview lease');
    return value;
  }
  function generation(owner: WebContents, value: unknown): boolean {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid preview generation');
    if (value < (generations.get(owner) ?? 0)) return false;
    generations.set(owner, value); return true;
  }
  deps.ipcMain.handle(channels.start, (event, scopeValue: unknown, sessionValue: unknown, leaseValue: unknown, bounds: unknown, sequence: unknown) => {
    const owner = identify(event);
    const leaseId = lease(leaseValue);
    if (!generation(owner, sequence)) return { leaseId, state: 'stopped', reason: 'stopped' };
    const scope = requireDesktopTargetScope(scopeValue);
    if (!deps.isHostActive(scope)) throw new Error('Computer preview target is unavailable');
    if (typeof sessionValue !== 'string' || !sessionValue || sessionValue.length > 1024) throw new Error('Invalid preview task');
    if (!validPreviewBounds(bounds)) throw new Error('Invalid preview slot');
    return preview.start(owner, desktopSessionResourceKey({ ...scope, sessionId: sessionValue }), leaseId, bounds);
  });
  deps.ipcMain.handle(channels.bounds, (event, leaseValue: unknown, bounds: ComputerUsePreviewBounds) => {
    preview.updateBounds(identify(event), lease(leaseValue), bounds);
  });
  deps.ipcMain.handle(channels.stop, (event, leaseValue: unknown, sequence: unknown) => {
    const owner = identify(event);
    const leaseId = lease(leaseValue);
    if (generation(owner, sequence)) preview.stop(owner, leaseId);
  });
  const unsubscribeLock = deps.subscribeLock(() => preview.locked());
  const timer = setInterval(() => { void preview.check(); }, 500);
  timer.unref();
  return {
    dispose() {
      disposed = true; clearInterval(timer); unsubscribeLock(); preview.dispose();
      for (const cleanup of [...tracked.values()]) cleanup();
      for (const channel of [channels.start, channels.bounds, channels.stop]) deps.ipcMain.removeHandler(channel);
    },
  };
}
