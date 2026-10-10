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

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface ComputerUseForegroundPolicySnapshot {
  readonly policy: 'never' | 'ask' | 'allow';
  readonly epoch: string;
}

export interface ComputerUseForegroundPolicyAuthority {
  read(): Promise<ComputerUseForegroundPolicySnapshot>;
  current(): ComputerUseForegroundPolicySnapshot;
  observe(policy: ComputerUseForegroundPolicySnapshot['policy']): void;
}

/** A policy transition retires old grants even when it returns to the same value. */
export function createComputerUseForegroundPolicyAuthority(
  readPolicy: () => Promise<ComputerUseForegroundPolicySnapshot['policy']>,
): ComputerUseForegroundPolicyAuthority {
  let snapshot: ComputerUseForegroundPolicySnapshot = { policy: 'never', epoch: randomUUID() };
  const observe = (policy: ComputerUseForegroundPolicySnapshot['policy']) => {
    if (policy !== snapshot.policy) snapshot = { policy, epoch: randomUUID() };
  };
  return {
    current: () => snapshot,
    observe,
    async read() {
      const before = snapshot;
      const policy = await readPolicy();
      // A concurrent settings update is newer than this read's starting point.
      if (snapshot === before) observe(policy);
      return snapshot;
    },
  };
}

interface ComputerUseForegroundInvocation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly isCurrent: () => boolean;
}

const admittedInvocation = new AsyncLocalStorage<ComputerUseForegroundInvocation>();

/** The model cannot supply this authority; only the admitted Desktop call binds it. */
export function withComputerUseForegroundAdmission<T>(
  admission: ComputerUseForegroundInvocation,
  run: () => T,
): T {
  return admittedInvocation.run(admission, run);
}

/** Rechecked by Runtime and the native queue immediately before sending input. */
export function computerUseForegroundAuthorized(
  context: Pick<ComputerUseForegroundInvocation, 'sessionId' | 'turnId' | 'toolCallId'>,
): boolean {
  const admission = admittedInvocation.getStore();
  return admission !== undefined
    && admission.sessionId === context.sessionId
    && admission.turnId === context.turnId
    && admission.toolCallId === context.toolCallId
    && admission.isCurrent();
}
