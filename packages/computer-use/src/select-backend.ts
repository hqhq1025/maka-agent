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

import { buildComputerUseTools, type ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import { type CuOverlayHook, type CuDispatchBackend } from '@maka/runtime/computer-use-types';
import {
  createCuaDriverBackend,
  type CuaDriverBackendOptions,
  type CuaDriverState,
} from './cua-driver-backend.js';

/** Desktop capability identity for the sole native executor. */
export const CU_BACKEND_IDS = ['cua-driver'] as const;
export type CuBackendId = (typeof CU_BACKEND_IDS)[number];

export const DEFAULT_CU_BACKEND_ID: CuBackendId = 'cua-driver';

type DisposableBackend = CuDispatchBackend & {
  clearSession?: (sessionId: string) => void;
  dispose?: () => void | Promise<void>;
  /** Loading/health belongs to the Desktop-owned native runtime. */
  executorState?: () => CuaDriverState;
};

export interface SelectedComputerUseBackend {
  backend?: DisposableBackend;
  tools: ComputerUseToolSet;
  backendId: CuBackendId | 'none';
}

function emptyTools(): ComputerUseToolSet {
  const tools = [] as unknown as ComputerUseToolSet;
  tools.clearSession = () => {};
  const snapshot = () => ({ status: 'unobserved' as const, generation: 0 });
  tools.sessionEvents = {
    snapshot,
    physicalUserIntervened: snapshot,
    interventionDebounceElapsed: snapshot,
    reobserveRequired: snapshot,
    screenLocked: snapshot,
    screenUnlocked: snapshot,
    blockedUrlDetected: snapshot,
    userStopped: snapshot,
    dynamicContentChanged: snapshot,
  };
  return tools;
}

const NONE: SelectedComputerUseBackend = {
  backend: undefined,
  tools: emptyTools(),
  backendId: 'none',
};

export interface CuaDriverSelection {
  /** Omitted means the default; see `DEFAULT_CU_BACKEND_ID`. */
  backendId?: 'cua-driver';
  requestAccessibilityPermission?: CuaDriverBackendOptions['requestAccessibilityPermission'];
  presentationTargetIdentity?: CuaDriverBackendOptions['presentationTargetIdentity'];
  listOwnedWindows?: CuaDriverBackendOptions['listOwnedWindows'];
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  foregroundAuthorized?: CuaDriverBackendOptions['foregroundAuthorized'];
  /**
   * Checked by the tool layer and again by the adapter before native dispatch.
   */
  screenLocked?: (context: { sessionId: string }) => boolean | Promise<boolean>;
  overlay?: CuOverlayHook;
  onTrace?: CuaDriverBackendOptions['onTrace'];
  createBackend?: (options: CuaDriverBackendOptions) => DisposableBackend;
}

export type ComputerUseBackendSelection = CuaDriverSelection;

export function selectComputerUseBackend(
  deps: CuaDriverSelection = {},
): SelectedComputerUseBackend {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return NONE;
  try {
    let tools: ComputerUseToolSet | undefined;
    const backend = (deps.createBackend ?? createCuaDriverBackend)({
      requestAccessibilityPermission: deps.requestAccessibilityPermission,
      presentationTargetIdentity: deps.presentationTargetIdentity,
      listOwnedWindows: deps.listOwnedWindows,
      screenLocked: deps.screenLocked,
      foregroundAuthorized: deps.foregroundAuthorized,
      ...(deps.compressFrame ? { compressFrame: deps.compressFrame } : {}),
      ...(deps.physicalInputRecentlyActive
        ? { physicalInputRecentlyActive: deps.physicalInputRecentlyActive }
        : {}),
      ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
      onSessionInvalidated: ({ sessionId }) => {
        tools?.sessionEvents.reobserveRequired(sessionId);
      },
    });
    tools = buildComputerUseTools({
      backend,
      foregroundAuthorized: deps.foregroundAuthorized,
      ...(deps.overlay ? { overlay: deps.overlay } : {}),
      ...(deps.screenLocked ? { screenLocked: deps.screenLocked } : {}),
    });
    return { backend, tools, backendId: DEFAULT_CU_BACKEND_ID };
  } catch {
    return NONE;
  }
}
