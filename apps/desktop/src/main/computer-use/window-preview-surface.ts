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

import { MessageChannelMain, WebContentsView, session, type Session, type WebContents, type View } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { viewportBoundsAtScale } from '../browser/logic.js';
import type { ComputerUsePreviewBounds } from '../../shared/computer-use-preview.js';
import { claimPreviewSession, closePreviewSurface, type PreviewSource, type PreviewSurface } from './window-preview.js';
import type { ComputerUsePreviewTarget, ComputerUseWindowIdentity } from './window-identity.js';
import { createPreviewFrameRelay } from './window-preview-frames.js';

const captureSessions = new WeakMap<WebContents, { session: Session; current?: object }>();

/** The fixed child receives either one video grant or one native frame port. */
export async function createComputerUsePreviewSurface(deps: {
  owner: WebContents;
  parent: View;
  documentPath: string;
  bounds: ComputerUsePreviewBounds;
  source: PreviewSource | undefined;
  target: ComputerUsePreviewTarget;
  startNativeCapture?: ComputerUseWindowIdentity['startCapture'];
  authorize(): boolean;
}): Promise<PreviewSurface> {
  const binding = claimPreviewSession(captureSessions, deps.owner,
    () => session.fromPartition('computer-preview-' + randomUUID(), { cache: false }));
  const captureSession = binding.session;
  const view = new WebContentsView({ webPreferences: {
    session: captureSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false,
    ...(!deps.source ? { preload: join(dirname(deps.documentPath), 'computer-use-preview-preload.cjs') } : {}),
  } });
  view.setVisible(false);
  view.setBackgroundColor('#101113');
  const wc = view.webContents;
  const trustedUrl = pathToFileURL(deps.documentPath).href;
  let destroyed = false;
  let pendingCapture = false;
  let captureChosen = false;
  let stopNative: (() => void) | undefined;
  let closeFrames: (() => void) | undefined;
  let nativeFailure: string | undefined;
  const trusted = () => binding.current() && !destroyed && !wc.isDestroyed() && wc.getURL() === trustedUrl && deps.authorize();
  captureSession.setPermissionCheckHandler((requester, permission, _origin, details) =>
    requester === wc && trusted() && pendingCapture && permission === 'media'
      && details.isMainFrame && details.mediaType === 'unknown');
  captureSession.setPermissionRequestHandler((requester, permission, callback, details) => {
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(requester === wc && trusted() && pendingCapture && permission === 'media'
      && details.isMainFrame && Array.isArray(types) && types.length === 0);
  });
  captureSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!deps.source || !trusted() || !pendingCapture || captureChosen || request.frame !== wc.mainFrame
      || !request.videoRequested || request.audioRequested) {
      callback({}); return;
    }
    captureChosen = true;
    pendingCapture = false;
    callback({ video: deps.source });
  }, { useSystemPicker: false });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.on('will-frame-navigate', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  const surface: PreviewSurface = {
    setBounds(bounds) {
      if (destroyed) return;
      const converted = viewportBoundsAtScale(bounds, deps.owner.getZoomFactor());
      if (!converted) { surface.destroy(); return; }
      view.setBounds(converted);
    },
    async start() {
      if (!trusted()) throw new Error('Preview target expired');
      if (!deps.source) {
        if (!deps.startNativeCapture) throw new Error('Native window capture is unavailable');
        const { port1, port2 } = new MessageChannelMain();
        const relay = createPreviewFrameRelay({ target: deps.target, authorize: trusted,
          send: (frame) => port1.postMessage(frame) });
        closeFrames = () => { relay.stop(); port1.close(); port2.close(); };
        let ready = false;
        port1.on('message', ({ data }) => {
          if (!trusted()) { surface.destroy(); return; }
          if (data?.type === 'ready' && !ready) {
            ready = true;
            try {
              stopNative = deps.startNativeCapture!(deps.target, (event) => {
                // Revocation can invalidate identity in the same turn. Preserve its terminal
                // status before trusted() checks identity; no pixels cross this branch.
                if (event.type === 'status' && ['capture_failed', 'permission_denied', 'stopped'].includes(event.status)) {
                  nativeFailure = event.status;
                  stopNative?.();
                  return;
                }
                if (!trusted()) { surface.destroy(); return; }
                if (event.type === 'frame') relay.frame(event);
              });
              if (!stopNative) nativeFailure = 'capture_failed';
            } catch { nativeFailure = 'capture_failed'; }
          } else if (data?.type === 'ack') relay.acknowledge(data.sequence);
          else if (data?.type === 'capture_failed') { nativeFailure = 'capture_failed'; stopNative?.(); }
        });
        port1.start();
        wc.postMessage('computer-preview:frames', null, [port2]);
        return;
      }
      pendingCapture = true;
      // An open product preview follows only targets accepted for that task.
      await wc.executeJavaScript('void window.makaPreview.start()', true);
    },
    async state() {
      if (nativeFailure) return nativeFailure;
      if (destroyed || wc.isDestroyed()) return 'stopped';
      const state = await wc.executeJavaScript('window.makaPreview.state()') as string;
      if (state === 'live' && trusted()) view.setVisible(true);
      return state;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; pendingCapture = false;
      // Stop native delivery before detaching the view, including when Electron cleanup throws.
      for (const stop of [closeFrames, stopNative]) {
        try { stop?.(); } catch { /* Always detach and close the child too. */ }
      }
      closePreviewSurface({
        deny() {
          // An old load/teardown may finish after the next capturer has installed its policy.
          if (!binding.release()) return;
          captureSession.setPermissionCheckHandler(() => false);
          captureSession.setPermissionRequestHandler((_requester, _permission, callback) => callback(false));
          captureSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
        },
        hide: () => view.setVisible(false),
        detach: () => deps.parent.removeChildView(view),
        // Closing the isolated capturer ends native tracks even if the parent or JS is gone.
        close: () => { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); },
      });
    },
  };
  try {
    deps.parent.addChildView(view);
    surface.setBounds(deps.bounds);
    await wc.loadFile(deps.documentPath);
    if (!trusted()) throw new Error('Preview target expired');
    // Navigation resets hidden-view throttling. Set this after load so even a
    // single frame can open the gate; host hiding still stops the whole preview.
    wc.setBackgroundThrottling(false);
    return surface;
  } catch (error) { surface.destroy(); throw error; }
}
