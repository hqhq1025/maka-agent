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
import { createCuaDriverBackend, type CuaDriverBackendOptions } from '../cua-driver-backend.js';

for (const scenario of ['valid', 'window-replaced', 'capture-failed', 'aborted'] as const) {
  test(`preview identity lease ${scenario} respects observation settlement`, async () => {
    const order: string[] = [];
    const abort = new AbortController();
    const context = { sessionId: 'task', turnId: 'turn', toolCallId: 'call' };
    const identity: NonNullable<CuaDriverBackendOptions['presentationTargetIdentity']> = {
      acquire(target, scope) {
        assert.deepEqual(target, { pid: 42, windowId: 7 });
        assert.equal(scope.sessionId, 'task');
        order.push('acquire');
        return 'retained-window';
      },
      validate(lease, target) {
        assert.equal(lease, 'retained-window');
        assert.deepEqual(target, { pid: 42, windowId: 7 });
        order.push('validate');
        return scenario !== 'window-replaced';
      },
      release(lease) {
        assert.equal(lease, 'retained-window');
        order.push('release');
      },
    };
    const backend = createCuaDriverBackend({
      presentationTargetIdentity: identity,
      createDriver: async () => ({
        metadata: async () => ({ driverVersion: '0.34.0' }),
        async callTool(name) {
          if (name === 'get_window_state') {
            order.push('capture');
            if (scenario === 'capture-failed') throw new Error('native capture failed');
            if (scenario === 'aborted') abort.abort();
          }
          return {
            isError: false,
            images: [],
            structuredJson: JSON.stringify(
              name === 'list_windows'
                ? { windows: [{ pid: 42, window_id: 7 }] }
                : name === 'get_window_state'
                  ? { pid: 42, window_id: 7, elements: [], tree_markdown: 'App' }
                  : {},
            ),
          };
        },
        shutdown: async () => {},
        uniffiDestroy() {},
      }),
    });
    const observing = backend.observeApp!(
      { app: '42', windowId: 7, includeScreenshot: false },
      abort.signal,
      context,
    );
    if (scenario === 'capture-failed' || scenario === 'aborted') {
      await assert.rejects(observing);
      assert.deepEqual(order, ['acquire', 'capture', 'release']);
    } else {
      const observation = await observing;
      assert.equal(observation.accessibilityText, 'App');
      assert.equal(
        observation.presentationTargetLease,
        scenario === 'valid' ? 'retained-window' : undefined,
      );
      assert.deepEqual(
        order,
        scenario === 'valid'
          ? ['acquire', 'capture', 'validate']
          : ['acquire', 'capture', 'validate', 'release'],
      );
    }
    await backend.dispose();
  });
}
