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

import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { COMPUTER_USE_PRESENTATION_CHANNELS as channels } from '../../shared/computer-use-presentation-channels.js';
import { desktopSessionResourceKey, requireDesktopTargetScope, type DesktopTargetScope } from '../../shared/runtime-host-identity.js';
import type { ComputerUsePresentationFeed } from './presentation-feed.js';

/** Frames are sent only to explicitly subscribed, trusted Desktop renderers. */
export function registerComputerUsePresentationIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  feed: ComputerUsePresentationFeed;
  ownsRenderer(contents: WebContents): boolean;
  isHostActive(scope: DesktopTargetScope): boolean;
  stop(sessionId: string): Promise<void>;
}): { dispose(): void } {
  const renderers = new Map<WebContents, { subscriptions: Map<string, () => void>; cleanup(): void }>();
  const identify = (event: IpcMainInvokeEvent, scopeValue: unknown, sessionValue: unknown): string => {
    if (!deps.ownsRenderer(event.sender) || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Computer Use presentation requires a trusted Desktop renderer');
    }
    const scope = requireDesktopTargetScope(scopeValue);
    if (!deps.isHostActive(scope)) throw new Error('Computer Use target is unavailable');
    if (typeof sessionValue !== 'string' || !sessionValue || sessionValue.length > 1024) throw new Error('Invalid Computer Use session');
    return desktopSessionResourceKey({ ...scope, sessionId: sessionValue });
  };
  const subscriptionId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('Invalid Computer Use subscription');
    return value;
  };
  deps.ipcMain.handle(channels.read, (event, scope: unknown, sessionId: unknown) => deps.feed.read(identify(event, scope, sessionId)));
  deps.ipcMain.handle(channels.subscribe, (event, scope: unknown, sessionId: unknown, tokenValue: unknown) => {
    const key = identify(event, scope, sessionId);
    const target = requireDesktopTargetScope(scope);
    const token = subscriptionId(tokenValue);
    const sender = event.sender;
    let renderer = renderers.get(sender);
    if (!renderer) {
      const subscriptions = new Map<string, () => void>();
      const cleanup = () => {
        for (const unsubscribe of subscriptions.values()) unsubscribe();
        subscriptions.clear();
        renderers.delete(sender);
        sender.off('destroyed', cleanup);
        sender.off('render-process-gone', cleanup);
        sender.off('did-start-navigation', navigated);
      };
      const navigated = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) cleanup(); };
      renderer = { subscriptions, cleanup };
      renderers.set(sender, renderer);
      sender.once('destroyed', cleanup);
      sender.once('render-process-gone', cleanup);
      sender.on('did-start-navigation', navigated);
    }
    renderer.subscriptions.get(token)?.();
    if (renderer.subscriptions.size >= 16 && !renderer.subscriptions.has(token)) throw new Error('Too many Computer Use subscriptions');
    renderer.subscriptions.set(token, deps.feed.subscribe(key, (value) => {
      if (!sender.isDestroyed() && deps.ownsRenderer(sender) && (value === null || deps.isHostActive(target))) sender.send(channels.changed, token, value);
    }));
    return deps.feed.read(key);
  });
  deps.ipcMain.handle(channels.unsubscribe, (event, tokenValue: unknown) => {
    const token = subscriptionId(tokenValue);
    const subscriptions = renderers.get(event.sender)?.subscriptions;
    subscriptions?.get(token)?.();
    subscriptions?.delete(token);
  });
  deps.ipcMain.handle(channels.stop, (event, scope: unknown, sessionId: unknown) => deps.stop(identify(event, scope, sessionId)));
  return {
    dispose(): void {
      for (const renderer of [...renderers.values()]) renderer.cleanup();
      for (const channel of [channels.read, channels.subscribe, channels.unsubscribe, channels.stop]) deps.ipcMain.removeHandler(channel);
    },
  };
}
