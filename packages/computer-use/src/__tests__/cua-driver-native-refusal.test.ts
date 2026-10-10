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
import { createCuaDriverBackend, type CuaDriverPort } from '../cua-driver-backend.js';

const context = { sessionId: 'task', turnId: 'turn', toolCallId: 'call' };
const signal = () => new AbortController().signal;
// Fixed source b0968e1: platform-linux/src/tools/impl_.rs DoubleClickTool invokes
// unavailable_gtk_pointer_background before snapshots.resolve and input. The
// input/delivery.rs FocusedInputOnly error uses cua-driver-core/src/delivery.rs's
// builder: isError + these fields, with no effect/route/delivery.
const nativeRefusal = {
  code: 'background_unavailable',
  detail:
    'the requested target has no focus-free input backend; the remaining XTest/X11 route can only deliver to the globally focused widget',
  escalation: {
    recommended: 'foreground',
    reason:
      'background input is unavailable on this surface; retry this action with delivery_mode:"foreground".',
  },
  suggestion: 'Retry this action with delivery_mode:"foreground".',
};

async function fixture(platform: NodeJS.Platform = 'linux') {
  let response = { isError: true, data: nativeRefusal as Record<string, unknown> };
  const calls: string[] = [];
  const port: CuaDriverPort = {
    metadata: async () => ({ driverVersion: '0.34.0' }),
    async callTool(name) {
      calls.push(name);
      if (name === 'double_click' || name === 'click')
        return {
          isError: response.isError,
          structuredJson: JSON.stringify(response.data),
          images: [],
        };
      const data =
        name === 'list_apps'
          ? { apps: [{ pid: 42, name: 'Fixture', running: true }] }
          : name === 'list_windows'
            ? { windows: [{ pid: 42, window_id: 7, title: 'Fixture' }] }
            : name === 'get_window_state'
              ? {
                  pid: 42,
                  window_id: 7,
                  elements: [
                    { element_index: 0, element_token: 'snapshot:0', role: 'push button' },
                  ],
                }
              : {};
      return { isError: false, structuredJson: JSON.stringify(data), images: [] };
    },
    shutdown: async () => {},
    uniffiDestroy() {},
  };
  const backend = createCuaDriverBackend({ platform, createDriver: async () => port });
  const observed = await backend.observeApp!(
    { app: 'Fixture', includeScreenshot: false },
    signal(),
    context,
  );
  const action = {
    type: 'double_click_element' as const,
    observationId: observed.observationId,
    elementId: observed.elements[0].elementId,
    delivery: 'background' as const,
  };
  return {
    backend,
    action,
    calls,
    setResponse: (data: Record<string, unknown>, isError = true) => {
      response = { data, isError };
    },
  };
}

test('0.34 Linux pre-dispatch double-click refusal preserves snapshot and requires foreground authorization', async () => {
  const f = await fixture();
  try {
    const refused = await f.backend.runSemantic!(f.action, signal(), context);
    assert.equal(refused.outcome.ok, false);
    if (!refused.outcome.ok) {
      assert.equal(refused.outcome.error, 'unsupported_action');
      assert.match(
        refused.outcome.message,
        /Foreground delivery requires current-task authorization/,
      );
    }
    assert.deepEqual(refused.outcome.evidence, { path: 'none', requestedDelivery: 'background' });
    f.setResponse({
      ...nativeRefusal,
      detail: 'A changed diagnostic does not change the typed refusal.',
    });
    const sameRefusal = await f.backend.runSemantic!(f.action, signal(), context);
    assert.deepEqual(sameRefusal.outcome.evidence, {
      path: 'none',
      requestedDelivery: 'background',
    });
    const foreground = { ...f.action, delivery: 'foreground' as const };
    const denied = await f.backend.runSemantic!(foreground, signal(), context);
    assert.equal(denied.outcome.ok, false);
    if (!denied.outcome.ok) assert.equal(denied.outcome.error, 'policy_denied');
    assert.deepEqual(
      f.calls.filter((name) => name === 'double_click'),
      ['double_click', 'double_click'],
    );
    f.setResponse(
      { effect: 'unverifiable', route: 'global_input', delivery: { mode: 'foreground' } },
      false,
    );
    const allowed = await f.backend.runSemantic!(foreground, signal(), {
      ...context,
      foregroundAuthorized: true,
    });
    assert.equal(allowed.outcome.ok, true);
    assert.equal(allowed.outcome.evidence?.actualDelivery, 'foreground');
    assert.deepEqual(
      f.calls.filter((name) => name === 'double_click'),
      ['double_click', 'double_click', 'double_click'],
    );
  } finally {
    await f.backend.dispose();
  }
});

for (const { name, data } of [
  { name: 'unrecognized error', data: { code: 'input_failure' } },
  { name: 'possible effect', data: { ...nativeRefusal, effect: 'unverifiable' } },
  {
    name: 'reported foreground delivery',
    data: { ...nativeRefusal, delivery: { mode: 'foreground' } },
  },
  { name: 'reported input route', data: { ...nativeRefusal, route: 'global_input' } },
  {
    name: 'unrecognized escalation',
    data: { ...nativeRefusal, escalation: { recommended: 'unknown' } },
  },
]) {
  test(`uncertain native error consumes observation: ${name}`, async () => {
    const f = await fixture();
    try {
      f.setResponse(data);
      const unknown = await f.backend.runSemantic!(f.action, signal(), context);
      assert.equal(unknown.outcome.ok, false);
      if (!unknown.outcome.ok) assert.equal(unknown.outcome.error, 'outcome_unknown');
      assert.notEqual(unknown.outcome.evidence?.path, 'none');
      const retry = await f.backend.runSemantic!(f.action, signal(), context);
      assert.equal(retry.outcome.ok, false);
      if (!retry.outcome.ok) assert.equal(retry.outcome.error, 'stale_frame');
      assert.equal(f.calls.filter((name) => name === 'double_click').length, 1);
    } finally {
      await f.backend.dispose();
    }
  });
}

test('effect-less refusal mapping does not apply to Mac double-click or another native tool', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const f = await fixture(platform);
    try {
      const action =
        platform === 'linux' ? { ...f.action, type: 'click_element' as const } : f.action;
      const result = await f.backend.runSemantic!(action, signal(), context);
      assert.equal(result.outcome.ok, false);
      if (!result.outcome.ok) assert.equal(result.outcome.error, 'outcome_unknown');
      assert.notEqual(result.outcome.evidence?.path, 'none');
    } finally {
      await f.backend.dispose();
    }
  }
});
