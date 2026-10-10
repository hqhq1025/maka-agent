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

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseDesktopSessionResourceKey, type DesktopTargetScope } from '../../shared/runtime-host-identity.js';

export interface ComputerUsePreviewTarget {
  readonly sessionId: string;
  readonly revision: number;
  readonly pid: number;
  readonly windowId: number;
  readonly appName: string;
  readonly windowTitle?: string;
  readonly leaseId: string;
}

/** An absent target can suspend a capture or end the user's preview request. */
export type ComputerUsePreviewTargetListener = (
  target: ComputerUsePreviewTarget | null,
  reason?: 'target_changed' | 'stopped',
) => void;

export interface DesktopWindowIdentityNative {
  acquire(pid: number, windowId: number): string | undefined;
  validate(leaseId: string, pid: number, windowId: number): boolean;
  validateForeground?(leaseId: string, pid: number, windowId: number): boolean;
  release(leaseId: string): void;
  applicationIcon?(leaseId: string, pid: number, windowId: number): Uint8Array | undefined;
  startCapture?(leaseId: string, pid: number, windowId: number,
    options: { maxWidth: number; maxHeight: number; fps: number },
    listener: (event: NativePreviewEvent) => void): string | undefined;
  stopCapture?(captureId: string): void;
  listOwnedWindows?(pid: number): readonly OwnedNativeWindow[];
}

export interface OwnedNativeWindow {
  pid: number; windowId: number; title: string; x: number; y: number; width: number; height: number;
  role: 'AXWindow' | 'AXSheet' | 'window' | 'dialog';
}

export type NativePreviewEvent = {
  type: 'frame'; captureId: string; leaseId: string; pid: number; windowId: number;
  width: number; height: number; stride: number; timestampMicros: number;
  format: 'BGRA'; data: Uint8Array;
} | { type: 'status'; captureId: string; status: 'starting' | 'live' | 'stopped' | 'permission_denied' | 'capture_failed' };

interface Binding {
  readonly sessionId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly leaseId: string;
  adopted: boolean;
}

/** Privately owns capture-time identity leases; no caller may choose a renderer source ID. */
export function createComputerUseWindowIdentity(options: {
  readonly platform?: NodeJS.Platform;
  readonly loadNative?: () => DesktopWindowIdentityNative;
} = {}) {
  const bindings = new Map<string, Binding>();
  const bySession = new Map<string, Set<string>>();
  let native: DesktopWindowIdentityNative | undefined;
  let loadAttempted = false;
  let disposed = false;
  const platform = options.platform ?? process.platform;
  function addon(): DesktopWindowIdentityNative | undefined {
    if (disposed || (platform !== 'darwin' && platform !== 'win32')) return undefined;
    if (!loadAttempted) {
      loadAttempted = true;
      try { native = (options.loadNative ?? loadDesktopWindowIdentityNative)(); } catch { /* Preview remains unavailable. */ }
    }
    return native;
  }
  function remove(leaseId: string): void {
    const binding = bindings.get(leaseId);
    if (!binding) return;
    bindings.delete(leaseId);
    const session = bySession.get(binding.sessionId);
    session?.delete(leaseId);
    if (!session?.size) bySession.delete(binding.sessionId);
    native?.release(leaseId);
  }
  return {
    applicationIcon(target: ComputerUsePreviewTarget): string | undefined {
      const binding = bindings.get(target.leaseId);
      if (!binding?.adopted || binding.sessionId !== target.sessionId || binding.pid !== target.pid
        || binding.windowId !== target.windowId || disposed) return undefined;
      try {
        if (!native?.validate(target.leaseId, target.pid, target.windowId)) return undefined;
        const bytes = native.applicationIcon?.(target.leaseId, target.pid, target.windowId);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > 64 * 1024) return undefined;
        const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
          || png.readUInt32BE(16) !== 32 || png.readUInt32BE(20) !== 32) return undefined;
        // The native read must not publish artwork from a replaced window.
        if (disposed || bindings.get(target.leaseId) !== binding
          || !native.validate(target.leaseId, target.pid, target.windowId)) return undefined;
        return `data:image/png;base64,${png.toString('base64')}`;
      }
      catch { return undefined; }
    },
    listOwnedWindows(pid: number): readonly OwnedNativeWindow[] {
      if (!['darwin', 'win32'].includes(platform) || !validNumber(pid)) return [];
      try { return addon()?.listOwnedWindows?.(pid) ?? []; } catch { return []; }
    },
    startCapture(target: ComputerUsePreviewTarget, listener: (event: NativePreviewEvent) => void): (() => void) | undefined {
      const reader = addon();
      const binding = bindings.get(target.leaseId);
      if (!binding?.adopted || binding.sessionId !== target.sessionId || binding.pid !== target.pid
        || binding.windowId !== target.windowId || !reader?.startCapture || !reader.stopCapture) return undefined;
      let stopped = false;
      const captureId = reader.startCapture(target.leaseId, target.pid, target.windowId,
        { maxWidth: 1280, maxHeight: 720, fps: 12 }, (event) => {
          if (stopped || disposed || bindings.get(target.leaseId) !== binding) return;
          listener(event);
        });
      if (!captureId) return undefined;
      return () => {
        if (stopped) return;
        stopped = true;
        reader.stopCapture!(captureId);
      };
    },
    acquire(target: { pid: number; windowId: number }, context: { sessionId: string }): string | undefined {
      const reader = addon();
      if (!reader || !validNumber(target.pid) || !validNumber(target.windowId)) return undefined;
      for (const id of [...(bySession.get(context.sessionId) ?? [])]) {
        const current = bindings.get(id)!;
        if (current.pid !== target.pid || current.windowId !== target.windowId) continue;
        try { if (reader.validate(id, target.pid, target.windowId)) return id; } catch { /* Replace an unreadable candidate. */ }
        remove(id);
      }
      let leaseId: string | undefined;
      try { leaseId = reader.acquire(target.pid, target.windowId); } catch { return undefined; }
      if (!leaseId || !/^[a-f0-9-]{36}$/i.test(leaseId)) return undefined;
      const existing = bindings.get(leaseId);
      if (existing) return undefined;
      if (bindings.size >= 64) { reader.release(leaseId); return undefined; }
      bindings.set(leaseId, { ...target, sessionId: context.sessionId, leaseId, adopted: false });
      const ids = bySession.get(context.sessionId) ?? new Set<string>();
      ids.add(leaseId);
      bySession.set(context.sessionId, ids);
      return leaseId;
    },
    validate(leaseId: string, pid: number, windowId: number): boolean {
      const binding = bindings.get(leaseId);
      if (!binding || binding.pid !== pid || binding.windowId !== windowId || disposed) return false;
      try { return native?.validate(leaseId, pid, windowId) === true; } catch { return false; }
    },
    validateForeground(leaseId: string, pid: number, windowId: number): boolean {
      const binding = bindings.get(leaseId);
      if (!binding || binding.pid !== pid || binding.windowId !== windowId || disposed || platform !== 'win32') return false;
      try { return native?.validateForeground?.(leaseId, pid, windowId) === true; } catch { return false; }
    },
    adopt(leaseId: string, sessionId: string, pid: number, windowId: number): boolean {
      const binding = bindings.get(leaseId);
      if (!binding || binding.sessionId !== sessionId || binding.pid !== pid || binding.windowId !== windowId || disposed) return false;
      try {
        if (native?.validate(leaseId, pid, windowId) !== true) return false;
      } catch { return false; }
      binding.adopted = true;
      // Successful observations supersede unpublished failed captures too.
      for (const other of [...(bySession.get(sessionId) ?? [])]) if (other !== leaseId) remove(other);
      return true;
    },
    /** Failed optional capture only releases its unpublished candidate. */
    release(leaseId: string): void {
      if (!bindings.get(leaseId)?.adopted) remove(leaseId);
    },
    releaseSession(sessionId: string): void {
      for (const id of [...(bySession.get(sessionId) ?? [])]) remove(id);
    },
    releaseScope(scope: DesktopTargetScope): void {
      for (const sessionId of [...bySession.keys()]) {
        const ref = parseDesktopSessionResourceKey(sessionId);
        if (ref.hostId === scope.hostId && ref.targetEpoch === scope.targetEpoch) {
          for (const id of [...(bySession.get(sessionId) ?? [])]) remove(id);
        }
      }
    },
    releaseAll(): void { for (const id of [...bindings.keys()]) remove(id); },
    dispose(): void {
      disposed = true;
      for (const id of [...bindings.keys()]) remove(id);
    },
  };
}

export type ComputerUseWindowIdentity = ReturnType<typeof createComputerUseWindowIdentity>;
function validNumber(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff; }

function loadDesktopWindowIdentityNative(): DesktopWindowIdentityNative {
  const require = createRequire(import.meta.url);
  const electron = require('electron') as typeof import('electron');
  const path = resolveDesktopWindowIdentityPath({
    isPackaged: electron.app.isPackaged, resourcesPath: process.resourcesPath, appPath: electron.app.getAppPath(),
  });
  const result = require(path) as Partial<DesktopWindowIdentityNative>;
  if (typeof result.acquire !== 'function' || typeof result.validate !== 'function' || typeof result.release !== 'function') {
    throw new Error('Desktop window identity addon is invalid');
  }
  return result as DesktopWindowIdentityNative;
}

export function resolveDesktopWindowIdentityPath(input: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'desktop-window-identity', 'maka_desktop_window_identity.node')
    : join(input.appPath, '..', '..', 'native', 'desktop-window-identity', 'build', 'maka_desktop_window_identity.node');
}
