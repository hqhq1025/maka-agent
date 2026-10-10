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

import type { CuObservation, CuOverlayHook, CuRunResult } from '@maka/runtime/computer-use-types';
import type { ComputerUsePresentation } from '../../shared/computer-use-presentation.js';
import { parseDesktopSessionResourceKey, type DesktopTargetScope } from '../../shared/runtime-host-identity.js';
import type { ComputerUsePreviewTarget, ComputerUsePreviewTargetListener, ComputerUseWindowIdentity } from './window-identity.js';

type Listener = (value: ComputerUsePresentation | null) => void;
interface Entry {
  value: ComputerUsePresentation | null;
  readonly listeners: Set<Listener>;
  readonly calls: Set<object>;
  stopped: boolean;
  previewTarget: ComputerUsePreviewTarget | null;
  readonly previewListeners: Set<ComputerUsePreviewTargetListener>;
  iconLeaseId?: string;
}

const MAX_SESSIONS = 32;
const MAX_FRAME_BASE64 = 8 * 1024 * 1024;

/** One bounded last frame per subscribed task, produced only by actual tool results. */
export function createComputerUsePresentationFeed(
  now: () => number = Date.now,
  isSessionActive: (sessionId: string) => boolean = () => true,
  preview?: {
    identity: ComputerUseWindowIdentity;
    mayPreview(): boolean;
    applicationIcon?(target: ComputerUsePreviewTarget): Promise<string | undefined>;
  },
) {
  const entries = new Map<string, Entry>();
  let revision = 0;
  let disposed = false;

  function entryFor(sessionId: string): Entry | undefined {
    if (disposed || !isSessionActive(sessionId)) return undefined;
    const existing = entries.get(sessionId);
    if (existing) return existing;
    if (entries.size >= MAX_SESSIONS) {
      const unused = [...entries].find(([, entry]) => !entry.listeners.size && !entry.previewListeners.size && !entry.calls.size);
      if (!unused) return undefined;
      preview?.identity.releaseSession(unused[0]);
      entries.delete(unused[0]);
    }
    const entry: Entry = { value: null, listeners: new Set(), calls: new Set(), stopped: false, previewTarget: null, previewListeners: new Set() };
    entries.set(sessionId, entry);
    return entry;
  }

  function publish(entry: Entry, value: Omit<ComputerUsePresentation, 'revision' | 'updatedAt'>): void {
    const sameApp = value.windowId === entry.value?.windowId && value.appName === entry.value?.appName;
    entry.value = { ...(sameApp && entry.value?.appIconDataUrl ? { appIconDataUrl: entry.value.appIconDataUrl } : {}),
      ...value, revision: ++revision, updatedAt: now() };
    for (const listener of entry.listeners) {
      try { listener(entry.value); } catch { /* Presentation cannot affect execution. */ }
    }
  }

  function clear(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) { preview?.identity.releaseSession(sessionId); return; }
    revokePreview(sessionId, entry);
    entries.delete(sessionId);
    // Existing subscriptions remain usable on the next turn, but all pending
    // completions belong to the discarded entry and cannot restore a frame.
    if ((entry.listeners.size || entry.previewListeners.size) && !disposed) {
      entries.set(sessionId, { value: null, listeners: entry.listeners, calls: new Set(), stopped: false, previewTarget: null, previewListeners: entry.previewListeners });
    }
    for (const listener of entry.listeners) {
      try { listener(null); } catch { /* Best-effort subscriber. */ }
    }
  }

  function revokePreview(sessionId: string, entry: Entry, reason: 'target_changed' | 'stopped' = 'stopped'): void {
    preview?.identity.releaseSession(sessionId);
    entry.previewTarget = null;
    entry.iconLeaseId = undefined;
    for (const listener of entry.previewListeners) {
      try { listener(null, reason); } catch { /* Preview consumers cannot affect execution. */ }
    }
  }

  function acceptPreview(sessionId: string, entry: Entry, observation: CuObservation | undefined): void {
    if (entry.stopped || !observation || !preview?.mayPreview() || !isSessionActive(sessionId)) {
      revokePreview(sessionId, entry);
      return;
    }
    const leaseId = observation.presentationTargetLease;
    if (!leaseId || !preview.identity.adopt(leaseId, sessionId, observation.pid, observation.windowId)) {
      revokePreview(sessionId, entry, 'target_changed');
      return;
    }
    const existing = entry.previewTarget;
    const target: ComputerUsePreviewTarget = {
      sessionId, revision: existing && existing.leaseId === leaseId ? existing.revision : ++revision,
      pid: observation.pid, windowId: observation.windowId,
      appName: observation.appId, ...(observation.windowTitle ? { windowTitle: observation.windowTitle } : {}), leaseId,
    };
    entry.previewTarget = target;
    for (const listener of entry.previewListeners) {
      try { listener(target); } catch { /* Preview consumers cannot affect execution. */ }
    }
  }

  function frameFor(entry: Entry, observation: CuObservation | undefined, shot = observation?.screenshot): ComputerUsePresentation['frame'] {
    if (preview && !preview.mayPreview()) return undefined;
    if (!entry.stopped && entry.listeners.size && !shot && observation?.windowId === entry.value?.windowId && observation?.appId === entry.value?.appName) {
      return entry.value?.frame;
    }
    return !entry.stopped && entry.listeners.size && shot &&
      shot.base64.length <= MAX_FRAME_BASE64 && shot.widthPx > 0 && shot.heightPx > 0
      ? { ...shot, capturedAt: observation?.capturedAt ?? now() }
      : undefined;
  }

  function updateApplicationIcon(sessionId: string, entry: Entry): void {
    const target = entry.previewTarget;
    if (!target || entry.iconLeaseId === target.leaseId || !preview?.applicationIcon) return;
    entry.iconLeaseId = target.leaseId;
    // Only native application artwork crosses this boundary. A late icon must
    // not replace the current app or revive a retired task.
    void Promise.resolve().then(() => preview.applicationIcon!(target)).then((icon) => {
      if (!icon || disposed
        || entries.get(sessionId) !== entry || entry.stopped || !isSessionActive(sessionId)
        || !preview.mayPreview() || entry.previewTarget?.leaseId !== target.leaseId
        || !preview.identity.validate(target.leaseId, target.pid, target.windowId)
        || !entry.value || entry.value.windowId !== target.windowId) return;
      publish(entry, { ...entry.value, appIconDataUrl: icon });
    }).catch(() => { /* Missing artwork leaves the ordinary Computer icon. */ });
  }

  const feed = {
    /** Private main-process identity; never serialised by the presentation IPC. */
    previewTarget: (sessionId: string): ComputerUsePreviewTarget | null => entries.get(sessionId)?.previewTarget ?? null,
    subscribePreviewTarget(sessionId: string, listener: ComputerUsePreviewTargetListener): () => void {
      const entry = entryFor(sessionId);
      if (!entry) throw new Error('Computer Use presentation capacity reached');
      entry.previewListeners.add(listener);
      return () => { entries.get(sessionId)?.previewListeners.delete(listener); };
    },
    /** Locking immediately revokes all native target leases and hides retained pixels. */
    suspendPreview(): void {
      preview?.identity.releaseAll();
      for (const [sessionId, entry] of entries) {
        revokePreview(sessionId, entry);
        if (entry.value?.frame) {
          const { frame: _frame, ...value } = entry.value;
          publish(entry, value);
        }
      }
    },
    read: (sessionId: string): ComputerUsePresentation | null => entries.get(sessionId)?.value ?? null,
    subscribe(sessionId: string, listener: Listener): () => void {
      const entry = entryFor(sessionId);
      if (!entry) throw new Error('Computer Use presentation capacity reached');
      entry.listeners.add(listener);
      return () => {
        const current = entries.get(sessionId);
        current?.listeners.delete(listener);
        if (current?.value && !current.listeners.size) {
          const { frame: _frame, ...value } = current.value;
          current.value = value;
        }
      };
    },
    stopping(sessionId: string): void {
      const entry = entries.get(sessionId);
      if (!entry) { preview?.identity.releaseSession(sessionId); return; }
      revokePreview(sessionId, entry);
      if (!entry.value) { entry.stopped = true; return; }
      entry.stopped = true;
      const { frame: _frame, ...value } = entry.value;
      publish(entry, { ...value, state: entry.calls.size ? 'stopping' : 'stopped' });
    },
    complete(sessionId: string): void {
      const entry = entries.get(sessionId);
      if (!entry) { preview?.identity.releaseSession(sessionId); return; }
      revokePreview(sessionId, entry);
      if (!entry.value) return;
      // Turn completion clears native sessions. An in-flight call may still
      // settle afterwards; its result must not restore the cleared preview.
      if (entry.calls.size) entry.stopped = true;
      const { frame, ...value } = entry.value;
      publish(entry, { ...value, ...(!entry.stopped && frame ? { frame } : {}), state: entry.calls.size ? 'stopping' : (entry.stopped ? 'stopped' : 'completed') });
    },
    /** A stop/permission release must keep native settlement visible. */
    release(sessionId: string): void {
      if (entries.get(sessionId)?.value) feed.stopping(sessionId);
      else clear(sessionId);
    },
    clear,
    retire(scope: DesktopTargetScope): void {
      preview?.identity.releaseScope(scope);
      for (const sessionId of [...entries.keys()]) {
        const ref = parseDesktopSessionResourceKey(sessionId);
        if (ref.hostId === scope.hostId && ref.targetEpoch === scope.targetEpoch) clear(sessionId);
      }
    },
    dispose(): void {
      disposed = true;
      for (const sessionId of entries.keys()) clear(sessionId);
      preview?.identity.dispose();
    },
    wrap(hook: CuOverlayHook): CuOverlayHook {
      const pending = new WeakMap<object, Entry>();
      return {
        onActionBegin(action, context) {
          let entry = entryFor(context.sessionId);
          if (entry?.stopped && !entry.calls.size) {
            entry = { value: null, listeners: entry.listeners, calls: new Set(), stopped: false, previewTarget: null, previewListeners: entry.previewListeners };
            entries.set(context.sessionId, entry);
          }
          if (entry && !entry.stopped) {
            entry.calls.add(context);
            pending.set(context, entry);
            // A duration wait has no input target and cannot switch applications.
            // Keep its accepted presentation; unbound input still revokes it.
            const targetWindowId = context.targetWindowId ?? (action.type === 'wait' ? entry.value?.windowId : undefined);
            const sameWindow = targetWindowId !== undefined && targetWindowId === entry.value?.windowId;
            if (entry.previewTarget && targetWindowId !== entry.previewTarget.windowId) revokePreview(context.sessionId, entry, 'target_changed');
            publish(entry, {
              sessionId: context.sessionId,
              state: 'running',
              action: action.type,
              ...(targetWindowId ? { windowId: targetWindowId } : {}),
              ...(sameWindow && entry.value?.appName ? { appName: entry.value.appName } : {}),
              ...(sameWindow && entry.value?.frame ? { frame: entry.value.frame } : {}),
            });
          }
          return hook.onActionBegin(action, context);
        },
        onActionEnd(action, result, context) {
          const entry = pending.get(context);
          pending.delete(context);
          if (entry && entries.get(context.sessionId) === entry) {
            entry.calls.delete(context);
            const observation = result?.observation;
            if (observation) acceptPreview(context.sessionId, entry, observation);
            const shot = result?.screenshot ?? observation?.screenshot;
            const frame = frameFor(entry, observation, shot) ??
              (action.type === 'wait' && !observation && !shot && !entry.stopped && (!preview || preview.mayPreview())
                ? entry.value?.frame : undefined);
            const windowId = observation?.windowId ?? context.targetWindowId ??
              (action.type === 'wait' ? entry.value?.windowId : undefined);
            publish(entry, {
              sessionId: context.sessionId,
              state: entry.stopped ? (entry.calls.size ? 'stopping' : 'stopped') : (entry.calls.size ? 'running' : 'settled'),
              action: action.type,
              ...(observation?.appId ? { appName: observation.appId } : entry.value?.appName ? { appName: entry.value.appName } : {}),
              ...(windowId ? { windowId } : {}),
              ...(result ? { outcome: outcomePresentation(result) } : {}),
              ...(frame ? { frame } : {}),
            });
            updateApplicationIcon(context.sessionId, entry);
          }
          return hook.onActionEnd?.(action, result, context);
        },
        onObservation(observation, context) {
          const entry = entryFor(context.sessionId);
          // This hook accepts only Runtime-admitted observations after its
          // cancellation/target fences. It performs no capture of its own.
          if (entry && !entry.calls.size) {
            entry.stopped = false;
            acceptPreview(context.sessionId, entry, observation);
            const frame = frameFor(entry, observation);
            publish(entry, {
              sessionId: context.sessionId,
              state: 'settled',
              action: 'observe',
              appName: observation.appId,
              windowId: observation.windowId,
              ...(frame ? { frame } : {}),
            });
            updateApplicationIcon(context.sessionId, entry);
          }
          return hook.onObservation?.(observation, context);
        },
      };
    },
  };
  return feed;
}

function outcomePresentation(result: CuRunResult): NonNullable<ComputerUsePresentation['outcome']> {
  const outcome = result.outcome;
  const delivery = outcome.evidence?.reason?.match(/^delivery:(background|foreground|not_applicable)$/)?.[1] as
    NonNullable<ComputerUsePresentation['outcome']>['delivery'];
  return {
    ok: outcome.ok,
    ...(!outcome.ok ? { error: outcome.error } : {}),
    ...(outcome.evidence?.effect ? { effect: outcome.evidence.effect } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

export type ComputerUsePresentationFeed = ReturnType<typeof createComputerUsePresentationFeed>;
