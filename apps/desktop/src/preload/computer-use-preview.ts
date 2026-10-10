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

import type { IpcRenderer } from 'electron';
import { COMPUTER_USE_PREVIEW_CHANNELS as channels } from '../shared/computer-use-preview-channels.js';
import type { ComputerUsePreviewBridge, ComputerUsePreviewStatus } from '../shared/computer-use-preview.js';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';

export function createComputerUsePreviewBridge(deps: {
  ipc: Pick<IpcRenderer, 'on' | 'removeListener'>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sessionRef(sessionId: string): Promise<{ scope: DesktopTargetScope; sessionId: string }>;
}): ComputerUsePreviewBridge {
  let generation = 0;
  let active: { leaseId: string; generation: number } | undefined;
  return {
    async start(sessionId, leaseId, bounds) {
      const attempt = { leaseId, generation: ++generation };
      active = attempt;
      const ref = await deps.sessionRef(sessionId);
      if (active !== attempt) return { leaseId, state: 'stopped', reason: 'stopped' };
      return await deps.invoke(channels.start, ref.scope, ref.sessionId, leaseId, bounds, attempt.generation) as ComputerUsePreviewStatus;
    },
    async updateBounds(leaseId, bounds) {
      if (active?.leaseId === leaseId) await deps.invoke(channels.bounds, leaseId, bounds);
    },
    async stop(leaseId) {
      if (active?.leaseId === leaseId) { active = undefined; generation++; }
      await deps.invoke(channels.stop, leaseId, generation);
    },
    subscribe(listener) {
      const consume = (_event: unknown, value: ComputerUsePreviewStatus) => listener(value);
      deps.ipc.on(channels.changed, consume);
      return () => deps.ipc.removeListener(channels.changed, consume);
    },
  };
}
