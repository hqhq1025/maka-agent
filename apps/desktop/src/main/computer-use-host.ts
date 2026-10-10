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

import { selectComputerUseBackend, type CuaDriverBackendOptions, type CuaDriverState, type SelectedComputerUseBackend } from '@maka/computer-use';
import type { CapabilityReasonCode } from '@maka/core/capabilities';
import type { CuOverlayHook } from '@maka/runtime/computer-use-types';
import { computerUseForegroundAuthorized } from './computer-use/foreground-admission.js';

export interface ComputerUseHostState { selected: SelectedComputerUseBackend }

/** The SDK is loaded lazily on the Desktop that owns the controlled computer. */
export function createComputerUseHost(input: {
  compressFrame?: CuaDriverBackendOptions['compressFrame'];
  physicalInputRecentlyActive: () => boolean | Promise<boolean>;
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  requestAccessibilityPermission?: CuaDriverBackendOptions['requestAccessibilityPermission'];
  presentationTargetIdentity?: CuaDriverBackendOptions['presentationTargetIdentity'];
  listOwnedWindows?: CuaDriverBackendOptions['listOwnedWindows'];
  onTrace?: CuaDriverBackendOptions['onTrace'];
  overlay?: CuOverlayHook;
}): ComputerUseHostState {
  return { selected: selectComputerUseBackend({ ...input, foregroundAuthorized: computerUseForegroundAuthorized }) };
}

export function createDesktopPhysicalInputGuard(getSystemIdleTime: () => number): () => boolean {
  return () => getSystemIdleTime() < 1;
}

export function computerUseServiceHealth(backendId: SelectedComputerUseBackend['backendId'], state: CuaDriverState | undefined): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded'; reason: CapabilityReasonCode;
} {
  if (backendId === 'none' || !state) return { state: 'not_available', reason: 'cu_executor_undistributable' };
  switch (state.state) {
    case 'disposed': return { state: 'not_available', reason: 'cu_executor_stopped' };
    case 'unavailable': return { state: 'not_available', reason: 'cu_executor_start_failed' };
    case 'starting': return { state: 'degraded', reason: 'cu_executor_recovering' };
    case 'ready': return state.environmentReady === false
      ? { state: 'degraded', reason: 'cu_backend_unavailable' }
      : { state: 'healthy', reason: 'cu_executor_ready' };
    default: return { state: 'not_run', reason: 'cu_executor_lazy_start' };
  }
}
