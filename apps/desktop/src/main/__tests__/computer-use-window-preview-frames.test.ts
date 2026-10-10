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
import { createPreviewFrameRelay } from '../computer-use/window-preview-frames.js';
import type { ComputerUsePreviewTarget, NativePreviewEvent } from '../computer-use/window-identity.js';

const target: ComputerUsePreviewTarget = { sessionId: 'task', revision: 1, pid: 12, windowId: 44, appName: 'Writer', leaseId: 'lease' };
const frame: Extract<NativePreviewEvent, { type: 'frame' }> = {
  type: 'frame', captureId: 'capture', leaseId: 'lease', pid: 12, windowId: 44,
  format: 'BGRA', width: 2, height: 2, stride: 8, timestampMicros: 1000,
  data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
};

test('stalled child is bounded to one frame and only the matching acknowledgement restores credit', () => {
  const sent: Array<{ sequence: number }> = [];
  const relay = createPreviewFrameRelay({ target, authorize: () => true, send: (item) => sent.push(item) });
  relay.frame(frame);
  for (let n = 0; n < 1000; n++) relay.frame(frame);
  assert.equal(sent.length, 1);
  relay.acknowledge(999);
  relay.frame(frame);
  assert.equal(sent.length, 1);
  relay.acknowledge(1);
  relay.frame(frame);
  assert.equal(sent.length, 2);
  relay.acknowledge(1);
  relay.frame(frame);
  assert.equal(sent.length, 2, 'a delayed duplicate cannot acknowledge the next frame');
  relay.stop();
  relay.acknowledge(2);
  relay.frame(frame);
  assert.equal(sent.length, 2);
});

test('identity mismatch, malformed layout, and expired authorization never deliver pixels', () => {
  const sent: unknown[] = [];
  let authorized = true;
  const relay = createPreviewFrameRelay({ target, authorize: () => authorized, send: (item) => sent.push(item) });
  for (const patch of [{ leaseId: 'old' }, { pid: 99 }, { windowId: 99 }, { width: 2.5 },
    { width: 2000 }, { stride: 4 }, { stride: -8 }, { data: new Uint8Array(15) }, { timestampMicros: NaN }]) {
    relay.frame({ ...frame, ...patch });
  }
  assert.equal(sent.length, 0);
  authorized = false;
  relay.frame(frame);
  assert.equal(sent.length, 0);
  authorized = true;
  relay.frame(frame);
  assert.equal(sent.length, 1);
});

test('transparent native captures do not consume credit or prevent a later opaque black frame', () => {
  const sent: Array<{ sequence: number; data: Uint8Array }> = [];
  const relay = createPreviewFrameRelay({ target, authorize: () => true, send: (item) => sent.push(item) });
  // Dimensions and packed strides match the real Writer Save and Go To captures.
  for (const [width, height] of [[430, 374], [460, 236]]) {
    const transparent = { ...frame, width, height, stride: width * 4, data: new Uint8Array(width * height * 4) };
    relay.frame(transparent);
    relay.frame(transparent);
  }
  assert.equal(sent.length, 0);
  relay.frame(frame);
  assert.equal(sent.length, 1, 'opaque black is valid content');
  assert.equal(sent[0]?.sequence, 1, 'rejected frames never reserve an acknowledgement');
  assert.equal(sent[0]?.data, frame.data, 'validation keeps the existing buffer');
  relay.acknowledge(1);
  relay.frame(frame);
  assert.equal(sent.length, 2);
});

test('only pixel alpha counts as content, including in a padded last row', () => {
  const sent: Array<{ data: Uint8Array }> = [];
  const relay = createPreviewFrameRelay({ target, authorize: () => true, send: (item) => sent.push(item) });
  const data = new Uint8Array(24).fill(255);
  for (const offset of [3, 7, 15, 19]) data[offset] = 0;
  const padded = { ...frame, stride: 12, data };
  relay.frame(padded);
  assert.equal(sent.length, 0, 'RGB and row padding cannot make transparent pixels visible');
  data[19] = 1;
  relay.frame(padded);
  assert.equal(sent.length, 1, 'a nonzero alpha in the final pixel is sufficient');
  assert.equal(sent[0]?.data, data);
});
