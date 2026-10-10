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
import { COMPUTER_USE_PRESENTATION_CHANNELS as channels } from '../shared/computer-use-presentation-channels.js';
import type { ComputerUsePresentation, ComputerUsePresentationBridge } from '../shared/computer-use-presentation.js';
import { desktopSessionResourceKey, parseDesktopSessionKey, type DesktopTargetScope } from '../shared/runtime-host-identity.js';

export function createComputerUsePresentationBridge(deps: {
  ipc: Pick<IpcRenderer, 'on' | 'removeListener'>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sessionRef(sessionId: string): Promise<{ scope: DesktopTargetScope; sessionId: string }>;
}): ComputerUsePresentationBridge {
  return {
    async read(sessionId) {
      const ref = await deps.sessionRef(sessionId);
      const value = await deps.invoke(channels.read, ref.scope, ref.sessionId) as ComputerUsePresentation | null;
      return value?.sessionId === desktopSessionResourceKey({ ...ref.scope, sessionId: ref.sessionId }) ? { ...value, sessionId } : null;
    },
    subscribe(sessionId, listener) {
      let disposed = false;
      let generation = 0;
      let active: { token: string; key: string; received: boolean; opening: Promise<unknown> } | undefined;
      const hostId = parseDesktopSessionKey(sessionId).hostId;
      const release = (binding: NonNullable<typeof active>) => {
        // Registration may still be in flight when a component closes or the
        // Host is replaced. Remove that exact token after its open settles.
        void binding.opening.catch(() => undefined).then(() => deps.invoke(channels.unsubscribe, binding.token)).catch(() => undefined);
      };
      const consume = (_event: unknown, incomingToken: string, value: ComputerUsePresentation | null) => {
        if (disposed || !active || incomingToken !== active.token || (value && value.sessionId !== active.key)) return;
        active.received = true;
        listener(value ? { ...value, sessionId } : null);
      };
      const open = async () => {
        const attempt = ++generation;
        let binding: typeof active;
        try {
          const ref = await deps.sessionRef(sessionId);
          if (disposed || attempt !== generation) return;
          const key = desktopSessionResourceKey({ ...ref.scope, sessionId: ref.sessionId });
          if (active?.key === key) return;
          if (active) { release(active); listener(null); }
          binding = { token: crypto.randomUUID(), key, received: false, opening: Promise.resolve<unknown>(undefined) };
          active = binding;
          binding.opening = deps.invoke(channels.subscribe, ref.scope, ref.sessionId, binding.token);
          const value = await binding.opening as ComputerUsePresentation | null;
          if (!disposed && active === binding && !binding.received && (!value || value.sessionId === key)) listener(value ? { ...value, sessionId } : null);
        } catch {
          if (!disposed && (binding ? active === binding : attempt === generation)) {
            if (active) release(active);
            active = undefined;
            listener(null);
          }
        }
      };
      const targetChanged = (_event: unknown, change: { hostId?: string; readiness?: string }) => {
        if (change.hostId === hostId && change.readiness === 'ready') void open();
      };
      deps.ipc.on(channels.changed, consume);
      deps.ipc.on('runtime-host-profiles:changed', targetChanged);
      void open();
      return () => {
        disposed = true;
        generation++;
        deps.ipc.removeListener(channels.changed, consume);
        deps.ipc.removeListener('runtime-host-profiles:changed', targetChanged);
        if (active) release(active);
      };
    },
    async stop(sessionId) {
      const ref = await deps.sessionRef(sessionId);
      await deps.invoke(channels.stop, ref.scope, ref.sessionId);
    },
  };
}
