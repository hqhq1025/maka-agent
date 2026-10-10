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

(() => {
  const video = document.querySelector('video');
  let stream = null;
  let version = 0;
  let state = 'starting';
  let nativePort = null;
  let nativeWriter = null;
  const stop = () => {
    version++;
    nativePort?.close();
    nativePort = null;
    void nativeWriter?.abort().catch(() => {});
    nativeWriter = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.srcObject = null;
    state = 'stopped';
  };
  const nativeFrames = async (event) => {
    if (event.source !== window || event.data !== 'computer-preview:frames' || event.ports.length !== 1) return;
    window.removeEventListener('message', nativeFrames);
    const attempt = ++version;
    const port = event.ports[0];
    nativePort = port;
    try {
      const track = new MediaStreamTrackGenerator({ kind: 'video' });
      const writer = track.writable.getWriter();
      nativeWriter = writer;
      stream = new MediaStream([track]);
      video.srcObject = stream;
      video.requestVideoFrameCallback(() => { if (attempt === version) state = 'live'; });
      void video.play().catch(() => {
        if (attempt === version) { state = 'capture_failed'; port.postMessage({ type: 'capture_failed' }); }
      });
      port.onmessage = async ({ data }) => {
        if (attempt !== version || data?.type !== 'frame') return;
        let frame;
        try {
          frame = new VideoFrame(data.data, {
            format: 'BGRA', codedWidth: data.width, codedHeight: data.height,
            layout: [{ offset: 0, stride: data.stride }], timestamp: data.timestampMicros,
            colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
          });
          await writer.write(frame);
          if (attempt === version) port.postMessage({ type: 'ack', sequence: data.sequence });
        } catch {
          if (attempt === version) { state = 'capture_failed'; port.postMessage({ type: 'capture_failed' }); }
        } finally { frame?.close(); }
      };
      port.start();
      port.postMessage({ type: 'ready' });
    } catch {
      state = 'capture_failed';
      port.postMessage({ type: 'capture_failed' });
    }
  };
  window.addEventListener('message', nativeFrames);
  const start = async () => {
    const attempt = ++version;
    try {
      const next = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { width: { ideal: 1280 }, frameRate: { ideal: 15, max: 20 } },
      });
      if (attempt !== version) { for (const track of next.getTracks()) track.stop(); return; }
      stream = next;
      video.srcObject = next;
      video.requestVideoFrameCallback(() => { if (attempt === version) state = 'live'; });
      for (const track of next.getTracks()) track.addEventListener('ended', stop, { once: true });
      await video.play();
      if (attempt !== version) { for (const track of next.getTracks()) track.stop(); return; }
    } catch (error) {
      state = error && error.name === 'NotAllowedError' ? 'permission_denied' : 'capture_failed';
    }
  };
  window.addEventListener('pagehide', stop);
  Object.defineProperty(window, 'makaPreview', {
    value: Object.freeze({ start, stop, state: () => state }), writable: false,
  });
})();
