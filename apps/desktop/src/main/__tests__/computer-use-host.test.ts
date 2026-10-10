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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComputerUseHost, computerUseServiceHealth } from '../computer-use-host.js';

test('Desktop selects the SDK without provisioning a legacy executable', async () => {
  const host = createComputerUseHost({ physicalInputRecentlyActive: () => false });
  assert.equal(host.selected.backendId, 'cua-driver');
  assert.equal(host.selected.tools.length, 1);
  assert.deepEqual(computerUseServiceHealth(host.selected.backendId, host.selected.backend?.executorState?.()), {
    state: 'not_run', reason: 'cu_executor_lazy_start',
  });
  await host.selected.backend?.dispose?.();
  assert.equal(computerUseServiceHealth('cua-driver', host.selected.backend?.executorState?.()).reason, 'cu_executor_stopped');
});

test('failed native import is unavailable, not healthy', () => {
  assert.deepEqual(computerUseServiceHealth('cua-driver', { state: 'unavailable' }), {
    state: 'not_available', reason: 'cu_executor_start_failed',
  });
});

test('a loaded SDK with missing desktop prerequisites remains degraded', () => {
  assert.deepEqual(computerUseServiceHealth('cua-driver', { state: 'ready', environmentReady: false }), {
    state: 'degraded', reason: 'cu_backend_unavailable',
  });
  assert.deepEqual(computerUseServiceHealth('cua-driver', { state: 'ready', environmentReady: true }), {
    state: 'healthy', reason: 'cu_executor_ready',
  });
});
