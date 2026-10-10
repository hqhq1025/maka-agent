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

import type { ComputerUsePreviewBounds, ComputerUsePreviewStatus } from '../../shared/computer-use-preview.js';
import type { ComputerUsePreviewTarget, ComputerUsePreviewTargetListener } from './window-identity.js';
export type { ComputerUsePreviewTarget } from './window-identity.js';

export interface PreviewSource { readonly id: string; readonly name: string }

/** One private session per product document; an old capturer cannot revoke its successor. */
export function claimPreviewSession<Owner extends object, Session>(
  slots: WeakMap<Owner, { session: Session; current?: object }>,
  owner: Owner,
  create: () => Session,
) {
  let slot = slots.get(owner);
  if (!slot) { slot = { session: create() }; slots.set(owner, slot); }
  const token = {};
  slot.current = token;
  return {
    session: slot.session,
    current: () => slot.current === token,
    release(): boolean {
      if (slot.current !== token) return false;
      slot.current = undefined;
      return true;
    },
  };
}

export interface PreviewSurface {
  setBounds(bounds: ComputerUsePreviewBounds): void;
  start(): Promise<void>;
  state(): Promise<string>;
  destroy(): void;
}

/** Native view detachment must never prevent capture teardown. */
export function closePreviewSurface(steps: {
  deny(): void;
  hide(): void;
  detach(): void;
  close(): void;
}): void {
  for (const operation of [steps.deny, steps.hide, steps.detach, steps.close]) {
    try { operation(); } catch { /* Continue unconditional capture shutdown. */ }
  }
}
interface Entry<Owner> {
  readonly owner: Owner;
  readonly leaseId: string;
  readonly key: string;
  bounds: ComputerUsePreviewBounds;
  unsubscribe?: () => void;
  status: ComputerUsePreviewStatus;
  capture?: Capture;
  lastLeaseId?: string;
}
interface Capture {
  readonly target: ComputerUsePreviewTarget;
  surface?: PreviewSurface;
  checking: boolean;
  readonly openedAt: number;
}

export function validPreviewBounds(input: unknown): input is ComputerUsePreviewBounds {
  if (!input || typeof input !== 'object') return false;
  const rect = input as ComputerUsePreviewBounds;
  return [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n))
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= 32768 && rect.y + rect.height <= 32768;
}

export function exactPreviewSource(sources: readonly PreviewSource[], windowId: number): PreviewSource | undefined {
  const matches = sources.filter((source) => {
    const match = /^window:(\d+):[01]$/.exec(source.id);
    return match && Number(match[1]) === windowId;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** A preview lease authorizes one fixed child document, never the product renderer. */
export function createComputerUseWindowPreview<Owner>(deps: {
  platform: NodeJS.Platform;
  target(key: string): ComputerUsePreviewTarget | null;
  subscribeTarget(key: string, listener: ComputerUsePreviewTargetListener): () => void;
  validateTarget(target: ComputerUsePreviewTarget): boolean;
  permissionDenied?(): boolean;
  locked(): boolean;
  visible(owner: Owner): boolean;
  sources(): Promise<readonly PreviewSource[]>;
  createSurface(owner: Owner, bounds: ComputerUsePreviewBounds, source: PreviewSource | undefined, authorize: () => boolean,
    target: ComputerUsePreviewTarget): Promise<PreviewSurface>;
  changed(owner: Owner, status: ComputerUsePreviewStatus): void;
  now?: () => number;
}) {
  const entries = new Map<Owner, Entry<Owner>>();
  let disposed = false;
  const now = deps.now ?? Date.now;
  function publish(entry: Entry<Owner>, state: ComputerUsePreviewStatus['state'], reason?: ComputerUsePreviewStatus['reason']) {
    entry.status = { leaseId: entry.leaseId, state, ...(reason ? { reason } : {}) };
    deps.changed(entry.owner, entry.status);
    return entry.status;
  }
  function closeCapture(entry: Entry<Owner>): void {
    const capture = entry.capture;
    // Revoke before destroy: a late callback from this surface cannot use its successor's authority.
    entry.capture = undefined;
    try { capture?.surface?.destroy(); } catch { /* Status publication must survive native view teardown. */ }
  }
  function stopEntry(entry: Entry<Owner>, reason: ComputerUsePreviewStatus['reason'] = 'stopped') {
    if (entries.get(entry.owner) !== entry) return;
    entries.delete(entry.owner);
    entry.unsubscribe?.();
    closeCapture(entry);
    publish(entry, reason === 'stopped' || reason === 'hidden' ? 'stopped' : 'unavailable', reason);
  }
  function pauseEntry(entry: Entry<Owner>): void {
    if (entries.get(entry.owner) !== entry) return;
    closeCapture(entry);
    if (entry.status.state !== 'waiting') publish(entry, 'waiting', 'target_changed');
  }
  function ownsCapture(entry: Entry<Owner>, capture: Capture): boolean {
    return !disposed && entries.get(entry.owner) === entry && entry.capture === capture;
  }
  function permitted(entry: Entry<Owner>): boolean {
    if (!deps.permissionDenied?.()) return true;
    stopEntry(entry, 'permission_denied');
    return false;
  }
  function current(entry: Entry<Owner>, capture: Capture): boolean {
    return ownsCapture(entry, capture)
      && permitted(entry)
      && deps.target(entry.key)?.leaseId === capture.target.leaseId
      && deps.visible(entry.owner) && !deps.locked() && deps.validateTarget(capture.target);
  }
  function requireCurrent(entry: Entry<Owner>, capture: Capture): boolean {
    if (current(entry, capture)) return true;
    if (!ownsCapture(entry, capture)) return false;
    if (deps.locked()) stopEntry(entry, 'locked');
    else if (!deps.visible(entry.owner)) stopEntry(entry, 'hidden');
    else pauseEntry(entry);
    return false;
  }
  async function openCapture(entry: Entry<Owner>, target: ComputerUsePreviewTarget): Promise<void> {
    closeCapture(entry);
    const capture: Capture = { target, checking: false, openedAt: now() };
    entry.capture = capture;
    entry.lastLeaseId = target.leaseId;
    if (!requireCurrent(entry, capture)) return;
    publish(entry, 'starting');
    try {
      // macOS receives BGRA from the retained native window. Electron's VM NV12 path can produce green frames.
      const source = deps.platform === 'win32' ? exactPreviewSource(await deps.sources(), target.windowId) : undefined;
      if (!requireCurrent(entry, capture)) return;
      if (deps.platform === 'win32' && !source) { stopEntry(entry, 'target_unavailable'); return; }
      const surface = await deps.createSurface(entry.owner, entry.bounds, source, () => current(entry, capture), target);
      if (!requireCurrent(entry, capture)) { surface.destroy(); return; }
      capture.surface = surface;
      surface.setBounds(entry.bounds);
      await surface.start();
      requireCurrent(entry, capture);
    } catch {
      if (requireCurrent(entry, capture)) stopEntry(entry, 'capture_failed');
    }
  }
  return {
    async start(owner: Owner, key: string, leaseId: string, bounds: ComputerUsePreviewBounds): Promise<ComputerUsePreviewStatus> {
      const previous = entries.get(owner);
      if (previous) stopEntry(previous);
      const unavailable = (reason: ComputerUsePreviewStatus['reason']): ComputerUsePreviewStatus => {
        const status = { leaseId, state: 'unavailable' as const, reason };
        deps.changed(owner, status); return status;
      };
      if (disposed || !validPreviewBounds(bounds)) return unavailable('hidden');
      if (deps.platform !== 'darwin' && deps.platform !== 'win32') return unavailable('unsupported_platform');
      if (deps.locked()) return unavailable('locked');
      if (deps.permissionDenied?.()) return unavailable('permission_denied');
      const target = deps.target(key);
      if (!target) return unavailable('target_unavailable');
      if (!deps.validateTarget(target)) return unavailable('identity_unavailable');
      const entry: Entry<Owner> = { owner, key, leaseId, bounds, status: { leaseId, state: 'starting' } };
      // Reserve before source enumeration, so close during an await cannot resurrect a view.
      entries.set(owner, entry);
      entry.unsubscribe = deps.subscribeTarget(key, (next, reason) => {
        if (entries.get(owner) !== entry) return;
        if (!next) {
          if (reason === 'target_changed') pauseEntry(entry);
          else stopEntry(entry);
        } else if (next.leaseId !== entry.lastLeaseId) {
          // A new Runtime-admitted lease can resume the user's still-open preview.
          // Repeated notifications for a revoked lease never restart capture.
          void openCapture(entry, next);
        }
      });
      await openCapture(entry, target);
      return entry.status;
    },
    updateBounds(owner: Owner, leaseId: string, bounds: ComputerUsePreviewBounds): void {
      const entry = entries.get(owner);
      if (!entry || entry.leaseId !== leaseId) return;
      if (!validPreviewBounds(bounds)) { stopEntry(entry, 'hidden'); return; }
      entry.bounds = bounds; entry.capture?.surface?.setBounds(bounds);
    },
    stop(owner: Owner, leaseId?: string): void {
      const entry = entries.get(owner);
      if (entry && (leaseId === undefined || entry.leaseId === leaseId)) stopEntry(entry);
    },
    async check(): Promise<void> {
      await Promise.all([...entries.values()].map(async (entry) => {
        if (!deps.visible(entry.owner)) { stopEntry(entry, 'hidden'); return; }
        if (deps.locked()) { stopEntry(entry, 'locked'); return; }
        if (!permitted(entry)) return;
        const capture = entry.capture;
        if (!capture) return;
        if (entry.status.state === 'starting' && now() - capture.openedAt > 30_000) { stopEntry(entry, 'capture_failed'); return; }
        if (!requireCurrent(entry, capture)) return;
        if (!capture.surface || capture.checking) return;
        capture.checking = true;
        try {
          const state = await capture.surface.state();
          if (!ownsCapture(entry, capture)) return;
          // An explicit capture failure ends this request even if identity also expired.
          if (state === 'capture_failed' || state === 'permission_denied') { stopEntry(entry, state); return; }
          // The target or owner can lose authority while the child reports its first frame.
          if (!requireCurrent(entry, capture)) return;
          if (state === 'live' && entry.status.state !== 'live') publish(entry, 'live');
          else if (state === 'stopped') stopEntry(entry);
        } catch { if (requireCurrent(entry, capture)) stopEntry(entry, 'capture_failed'); }
        finally { capture.checking = false; }
      }));
    },
    locked(): void { for (const entry of [...entries.values()]) stopEntry(entry, 'locked'); },
    dispose(): void { disposed = true; for (const entry of [...entries.values()]) stopEntry(entry); },
  };
}
