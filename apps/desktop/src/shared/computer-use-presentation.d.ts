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

/** Ephemeral task presentation. Frames never enter Session persistence. */
export interface ComputerUsePresentation {
  readonly sessionId: string;
  readonly revision: number;
  readonly state: 'running' | 'stopping' | 'stopped' | 'settled' | 'completed';
  readonly action?: string;
  readonly appName?: string;
  /** Small native application icon, resolved by Desktop from the accepted window. */
  readonly appIconDataUrl?: string;
  readonly windowId?: number;
  readonly updatedAt: number;
  readonly outcome?: {
    readonly ok: boolean;
    readonly error?: string;
    readonly effect?: 'confirmed' | 'unverifiable' | 'suspected_noop' | 'refused';
    readonly delivery?: 'background' | 'foreground' | 'not_applicable';
  };
  /** Last authorized capture, not a live screen stream; absent before capture. */
  readonly frame?: {
    readonly base64: string;
    readonly mimeType: 'image/png' | 'image/jpeg';
    readonly widthPx: number;
    readonly heightPx: number;
    readonly capturedAt: number;
  };
}

export interface ComputerUsePresentationBridge {
  read(sessionId: string): Promise<ComputerUsePresentation | null>;
  subscribe(sessionId: string, listener: (value: ComputerUsePresentation | null) => void): () => void;
  stop(sessionId: string): Promise<void>;
}
