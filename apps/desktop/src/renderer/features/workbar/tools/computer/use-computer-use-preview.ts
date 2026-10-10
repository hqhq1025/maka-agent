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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComputerUsePreviewStatus } from '../../../../../shared/computer-use-preview.js';
import { isNativeSurfaceOccluded, watchNativeSurface } from '../../../../application/contracts/native-surface-occlusion.js';
import { useWorkbarServices } from '../../services-context.js';

/** The click starts media in an isolated native document; this renderer owns only its slot. */
export function useComputerUsePreview(sessionId: string, active: boolean, permitted: boolean) {
  const { computerUsePreview: service } = useWorkbarServices();
  const slotRef = useRef<HTMLDivElement>(null);
  const lease = useRef<{ id: string; pushed: boolean } | undefined>(undefined);
  const showable = active && permitted;
  const binding = useMemo(() => ({ sessionId, service, showable }), [sessionId, service, showable]);
  const [result, setResult] = useState<{ binding: typeof binding; status: ComputerUsePreviewStatus }>();

  const stop = useCallback((reason: 'stopped' | 'hidden' = 'stopped') => {
    const current = lease.current;
    if (!current || !service) return;
    lease.current = undefined;
    setResult({ binding, status: { leaseId: current.id, state: 'stopped', reason } });
    void service.stop(current.id).catch(() => {
      setResult((value) => value?.status.leaseId === current.id
        ? { binding, status: { leaseId: current.id, state: 'unavailable', reason: 'capture_failed' } }
        : value);
    });
  }, [service, binding]);

  useEffect(() => {
    if (!service || !showable) return;
    let unsubscribe: () => void;
    try {
      unsubscribe = service.subscribe((status) => {
        if (status.leaseId !== lease.current?.id) return;
        lease.current.pushed = true;
        setResult({ binding, status });
      });
    } catch {
      setResult({ binding, status: { leaseId: '', state: 'unavailable', reason: 'capture_failed' } });
      return;
    }
    return () => {
      unsubscribe();
      const current = lease.current;
      lease.current = undefined;
      if (current) void service.stop(current.id).catch(() => undefined);
    };
  }, [service, binding, showable]);

  const start = useCallback(() => {
    const slot = slotRef.current;
    if (!service || !showable || !slot) return;
    stop();
    const rect = slot.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || isNativeSurfaceOccluded(rect, slot.ownerDocument)) return;
    const current = { id: crypto.randomUUID(), pushed: false };
    lease.current = current;
    setResult({ binding, status: { leaseId: current.id, state: 'starting' } });
    // Keep this invocation in the user's click turn so main can preserve its media gesture.
    void service.start(sessionId, current.id, {
      x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
    }).then((status) => {
      if (lease.current !== current || current.pushed || status.leaseId !== current.id) return;
      setResult({ binding, status });
    }, () => {
      if (lease.current !== current) return;
      setResult({ binding, status: { leaseId: current.id, state: 'unavailable', reason: 'capture_failed' } });
    });
  }, [service, sessionId, binding, showable, stop]);

  const status = showable && result?.binding === binding ? result.status : undefined;
  const visible = status?.state === 'starting' || status?.state === 'live' || status?.state === 'waiting';
  useEffect(() => {
    const slot = slotRef.current;
    if (!service || !visible || !slot) return;
    let last = '';
    const sync = () => {
      const current = lease.current;
      if (!current) return;
      const rect = slot.getBoundingClientRect();
      const panel = slot.closest('.maka-computer-panel')?.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || (panel && (rect.top < panel.top || rect.bottom > panel.bottom))
        || isNativeSurfaceOccluded(rect, slot.ownerDocument)) {
        stop('hidden');
        return;
      }
      const bounds = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === last) return;
      last = key;
      void service.updateBounds(current.id, bounds).catch(() => {
        if (lease.current === current) stop('hidden');
      });
    };
    const watch = watchNativeSurface(slot, sync);
    slot.ownerDocument.addEventListener('scroll', sync, true);
    return () => {
      watch.dispose();
      slot.ownerDocument.removeEventListener('scroll', sync, true);
    };
  }, [service, visible, status?.leaseId, stop]);

  return { slotRef, status, available: service !== undefined, start, stop: () => stop() };
}
