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

// Saved native frames exercise the actual production WCV, preload and bounded port.
// This transport probe does not replace live macOS capture acceptance.
import assert from 'node:assert/strict';
import { app, BrowserWindow, webContents } from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComputerUsePreviewSurface } from '../../apps/desktop/dist/main/computer-use/window-preview-surface.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.env.MAKA_PREVIEW_BGRA_SOURCE;
const output = process.env.MAKA_PREVIEW_BGRA_OUTPUT;
assert.ok(source && output, 'Set source frame and output directories');
mkdirSync(join(output, 'profile'), { recursive: true });
app.setPath('userData', join(output, 'profile'));
app.disableHardwareAcceleration();
async function run() {
  const report = {
    scope: 'Production isolated native frame transport, using saved macOS BGRA frames',
    versions: process.versions,
    results: [],
    passed: false,
  };
  let parent;
  let surface;
  try {
    await app.whenReady();
    parent = new BrowserWindow({
      width: 600,
      height: 500,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    await parent.loadURL('about:blank');
    let deliver;
    let stopped = 0;
    let authorized = true;
    const target = {
      sessionId: 'transport-probe',
      revision: 1,
      leaseId: 'probe-lease',
      pid: 42,
      windowId: 7,
      appName: 'Saved frame',
    };
    surface = await createComputerUsePreviewSurface({
      owner: parent.webContents,
      parent: parent.contentView,
      documentPath: join(root, 'apps/desktop/dist/overlay/computer-use-preview.html'),
      bounds: { x: 10, y: 10, width: 480, height: 328 },
      target,
      source: undefined,
      authorize: () => authorized,
      startNativeCapture: (_target, listener) => {
        deliver = listener;
        return () => {
          stopped++;
        };
      },
    });
    await surface.start();
    const previewView = parent.contentView.children.at(-1);
    assert.ok(previewView);
    assert.equal(
      previewView.getVisible(),
      false,
      'the child stays hidden before its first presented frame',
    );
    const wait = async (predicate) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error('Preview transport timed out');
    };
    await wait(() => !!deliver);
    const child = webContents
      .getAllWebContents()
      .find((item) => item.getURL().endsWith('/computer-use-preview.html'));
    assert.ok(child);
    const metadata = JSON.parse(await readFile(join(source, 'sck-pixel-probe.json'), 'utf8'));
    for (const sample of metadata.modes.find((mode) => mode.mode === 'BGRA').frames) {
      const bytes = await readFile(join(source, sample.planes[0].filename));
      const frame = {
        type: 'frame',
        captureId: 'probe',
        leaseId: target.leaseId,
        pid: target.pid,
        windowId: target.windowId,
        format: 'BGRA',
        width: sample.width,
        height: sample.height,
        stride: sample.planes[0].stride,
        timestampMicros: sample.frame * 1_000_000,
        data: bytes,
      };
      const painted = child.executeJavaScript(`new Promise(resolve => {
      const video = document.querySelector('video');
      video.requestVideoFrameCallback(() => {
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let binary = ''; for (const byte of pixels) binary += String.fromCharCode(byte);
        resolve({width: canvas.width, height: canvas.height, pixels: btoa(binary)});
      });
    })`);
      // Register the video callback before sending the next native frame.
      await child.executeJavaScript('true');
      deliver(frame);
      const timeout = setTimeout(() => app.exit(2), 20_000);
      const rendered = await painted;
      clearTimeout(timeout);
      assert.equal(rendered.width, frame.width);
      assert.equal(rendered.height, frame.height);
      const rgba = Buffer.from(rendered.pixels, 'base64');
      let opaque = 0;
      let differences = 0;
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) {
          const src = y * frame.stride + x * 4,
            dst = (y * frame.width + x) * 4;
          if (bytes[src + 3] !== 255) continue;
          opaque++;
          if (
            rgba[dst] !== bytes[src + 2] ||
            rgba[dst + 1] !== bytes[src + 1] ||
            rgba[dst + 2] !== bytes[src]
          )
            differences++;
        }
      assert.equal(differences, 0);
      report.results.push({ frame: sample.frame, opaque, differences });
      await writeFile(
        join(output, `frame-${sample.frame}.png`),
        (await child.capturePage()).toPNG(),
      );
      assert.equal(await surface.state(), 'live');
      assert.equal(previewView.getVisible(), true, 'a presented frame opens the visibility gate');
    }
    authorized = false;
    deliver({ type: 'status', captureId: 'probe', status: 'live' });
    assert.equal(stopped, 1);
    await wait(() => child.isDestroyed());
    surface.destroy();
    assert.equal(stopped, 1);
    report.passed = true;
    report.firstFrameGate = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    surface?.destroy();
    parent?.destroy();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    app.exit(report.passed ? 0 : 1);
  }
}
void run();
