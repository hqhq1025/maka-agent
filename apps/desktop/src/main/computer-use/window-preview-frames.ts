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

import type { ComputerUsePreviewTarget, NativePreviewEvent } from './window-identity.js';

type Frame = Extract<NativePreviewEvent, { type: 'frame' }>;

function hasVisiblePixel(frame: Frame): boolean {
  for (let row = 0; row < frame.height; row++) {
    const end = row * frame.stride + frame.width * 4;
    for (let alpha = row * frame.stride + 3; alpha < end; alpha += 4) {
      if (frame.data[alpha] > 0) return true;
    }
  }
  return false;
}

/** One frame may cross IPC at a time. A stalled child never accumulates native buffers. */
export function createPreviewFrameRelay(deps: {
  target: ComputerUsePreviewTarget;
  authorize(): boolean;
  send(frame: { type: 'frame'; sequence: number; width: number; height: number; stride: number;
    timestampMicros: number; data: Uint8Array }): void;
}) {
  let stopped = false;
  let sequence = 0;
  let pending: number | undefined;
  return {
    frame(frame: Frame): void {
      if (stopped || pending !== undefined || !deps.authorize()) return;
      if (frame.leaseId !== deps.target.leaseId || frame.pid !== deps.target.pid
        || frame.windowId !== deps.target.windowId || frame.format !== 'BGRA') return;
      if (![frame.width, frame.height, frame.stride, frame.timestampMicros].every(Number.isSafeInteger)
        || frame.width <= 0 || frame.height <= 0 || frame.width > 1920 || frame.height > 1920
        || frame.width * frame.height > 2073600 || frame.stride < frame.width * 4
        || frame.stride * frame.height > 16 * 1024 * 1024 || frame.timestampMicros < 0
        || !(frame.data instanceof Uint8Array) || frame.data.byteLength !== frame.stride * frame.height) return;
      // SCK can return an all-transparent window. Keep the first-frame gate
      // waiting without reserving IPC credit. Opaque black is valid content.
      if (!hasVisiblePixel(frame)) return;
      pending = ++sequence;
      deps.send({ type: 'frame', sequence, width: frame.width, height: frame.height,
        stride: frame.stride, timestampMicros: frame.timestampMicros, data: frame.data });
    },
    acknowledge(value: unknown): void { if (value === pending) pending = undefined; },
    stop(): void { stopped = true; pending = undefined; },
  };
}
