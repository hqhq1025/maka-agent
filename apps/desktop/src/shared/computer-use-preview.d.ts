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

/** A renderer's measured slot, in CSS pixels. Never identifies the captured window. */
export interface ComputerUsePreviewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComputerUsePreviewStatus {
  readonly leaseId: string;
  readonly state: 'starting' | 'live' | 'waiting' | 'unavailable' | 'stopped';
  readonly reason?: 'target_unavailable' | 'identity_unavailable' | 'unsupported_platform'
    | 'permission_denied' | 'capture_failed' | 'target_changed' | 'locked'
    | 'hidden' | 'stopped';
}

/** Media remains in a fixed, isolated Desktop document, outside the product renderer. */
export interface ComputerUsePreviewBridge {
  start(sessionId: string, leaseId: string, bounds: ComputerUsePreviewBounds): Promise<ComputerUsePreviewStatus>;
  updateBounds(leaseId: string, bounds: ComputerUsePreviewBounds): Promise<void>;
  stop(leaseId: string): Promise<void>;
  subscribe(listener: (value: ComputerUsePreviewStatus) => void): () => void;
}
