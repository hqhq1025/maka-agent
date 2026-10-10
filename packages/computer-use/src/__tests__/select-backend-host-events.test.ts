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
import type { ComputerUseActivity } from '@maka/core/computer-use';
import type { CuDispatchBackend } from '@maka/runtime/computer-use-types';
import { parseObservationText } from '@maka/runtime/test-only/observation-text-reader';
import {
  createCuaDriverBackend,
  type CuaDriverBackendOptions,
  type CuaDriverPort,
} from '../cua-driver-backend.js';
import { selectComputerUseBackend } from '../select-backend.js';

test('service invalidation producer advances Runtime to reobserve', async () => {
  let invalidate: ((input: { sessionId: string; outcomeUnknown: boolean }) => void) | undefined;
  const backend: CuDispatchBackend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return {
        observationId: 'backend-observation',
        appId: 'Fixture',
        pid: 42,
        windowId: 7,
        elements: [],
      };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  const selected = selectComputerUseBackend({
    createBackend(options) {
      invalidate = options.onSessionInvalidated as typeof invalidate;
      return backend;
    },
  });
  const [tool] = selected.tools;
  await tool.impl(
    {
      action: 'observe',
      app: 'Fixture',
      include_screenshot: false,
    } as never,
    {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'observe',
      cwd: '/tmp',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'active');
  invalidate?.({
    sessionId: 'session-1',
    outcomeUnknown: false,
  });
  assert.equal(selected.tools.sessionEvents.snapshot('session-1').status, 'reobserve_required');
});

test('physical input policy is passed to the selected backend', () => {
  const physicalInputRecentlyActive = () => true;
  let received: CuaDriverBackendOptions['physicalInputRecentlyActive'];
  const backend: CuDispatchBackend = {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
  selectComputerUseBackend({
    physicalInputRecentlyActive,
    createBackend(options) {
      received = options.physicalInputRecentlyActive;
      return backend;
    },
  });
  assert.equal(received, physicalInputRecentlyActive);
});

function selectedDriver(
  platform: NodeJS.Platform,
  afterFrame: 'closed' | 'transient' | 'available' | 'refused-target' | 'refused-element',
) {
  let clicks = 0;
  let snapshots = 0;
  let captureFailed = false;
  let windowClosed = false;
  const driver: CuaDriverPort = {
    async metadata() {
      return { driverVersion: '0.34.0' };
    },
    async callTool(name) {
      let data: Record<string, unknown> = {};
      if (name === 'check_permissions') {
        data = { accessibility: true, screen_recording: true, uia: true };
      }
      if (name === 'list_apps') {
        data = { apps: [{ pid: 42, name: 'Fixture', bundle_id: 'test.fixture', running: true }] };
      }
      if (name === 'list_windows') {
        data = {
          windows:
            windowClosed || (clicks && afterFrame === 'closed') ? [] : [{ pid: 42, window_id: 7 }],
        };
      }
      if (name === 'get_window_state') {
        if (clicks && (afterFrame === 'closed' || (afterFrame === 'transient' && !captureFailed))) {
          captureFailed = true;
          return { isError: true, structuredJson: '{"code":"target_missing"}', images: [] };
        }
        snapshots += 1;
        data = {
          pid: 42,
          window_id: 7,
          tree_markdown: 'Close',
          elements: [
            {
              element_index: 1,
              element_token: `snapshot:${snapshots}`,
              role: 'Button',
              label: 'Close',
              actions: ['AXPress'],
            },
            ...(afterFrame === 'refused-element'
              ? [
                  {
                    element_index: 2,
                    element_token: `snapshot:${snapshots}:other`,
                    role: 'Button',
                    label: 'Other',
                    actions: ['AXPress'],
                  },
                ]
              : []),
          ],
        };
      }
      if (name === 'click' || name === 'double_click') {
        clicks += 1;
        if (clicks === 1 && (afterFrame === 'refused-target' || afterFrame === 'refused-element')) {
          windowClosed = afterFrame === 'refused-target';
          return {
            isError: true,
            structuredJson: JSON.stringify(
              windowClosed
                ? { code: 'window_target_not_found', effect: 'refused', pid: 42, window_id: 7 }
                : { code: 'element_not_visible', effect: 'refused' },
            ),
            images: [],
          };
        }
        data = { effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' } };
      }
      return { isError: false, structuredJson: JSON.stringify(data), images: [] };
    },
    async shutdown() {},
    uniffiDestroy() {},
  };
  const selected = selectComputerUseBackend({
    createBackend(options) {
      return createCuaDriverBackend({ ...options, platform, createDriver: async () => driver });
    },
  });
  const [tool] = selected.tools;
  assert.ok(tool);
  let callId = 0;
  const invoke = (input: Record<string, unknown>, sessionId = 'task') =>
    tool.impl(input as never, {
      sessionId,
      turnId: 'turn',
      toolCallId: `call-${++callId}`,
      cwd: '/tmp',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    }) as Promise<{
      text: string;
      modelText?: string;
      error?: string;
      computerUse?: ComputerUseActivity;
    }>;
  return {
    selected,
    invoke,
    clickCount: () => clicks,
    snapshotCount: () => snapshots,
    restoreWindow() {
      windowClosed = false;
    },
    async observe(sessionId = 'task') {
      const result = await invoke(
        { action: 'observe', app: 'Fixture', include_screenshot: false },
        sessionId,
      );
      assert.equal(result.error, undefined, result.text);
      const frame = parseObservationText(result.modelText ?? result.text);
      assert.ok(frame, result.modelText ?? result.text);
      return frame;
    },
  };
}

test('an SDK target refusal retires the public frame even when the closed window cannot be refreshed', async (t) => {
  const fixture = selectedDriver('win32', 'refused-target');
  t.after(() => fixture.selected.backend?.dispose?.());
  const frame = await fixture.observe();
  const action = {
    action: 'click_element',
    observation_id: frame.observation_id,
    element_id: frame.elements[0]!.element_id,
  };
  const refused = await fixture.invoke(action);
  const stateAfterRefusal = fixture.selected.tools.sessionEvents.snapshot('task');
  const snapshotsAfterRefusal = fixture.snapshotCount();
  fixture.restoreWindow();
  const oldFrame = await fixture.invoke({ ...action, action: 'double_click_element' });
  assert.equal(
    fixture.clickCount(),
    1,
    'a different action must not reuse the expired SDK snapshot',
  );
  assert.equal(refused.computerUse?.outcome.execution, 'not_started');
  assert.doesNotMatch(
    refused.modelText ?? refused.text,
    /still current|remains actionable|reached the executor/,
  );
  assert.equal(stateAfterRefusal.status, 'reobserve_required');
  assert.equal(snapshotsAfterRefusal, 1);
  assert.equal(oldFrame.error, 'reobserve_required');
  assert.equal(oldFrame.computerUse?.outcome.execution, 'not_started');

  const fresh = await fixture.observe();
  assert.notEqual(fresh.observation_id, frame.observation_id);
  assert.notEqual(fresh.elements[0]!.element_id, frame.elements[0]!.element_id);
  const recovered = await fixture.invoke({
    action: 'click_element',
    observation_id: fresh.observation_id,
    element_id: fresh.elements[0]!.element_id,
  });
  assert.equal(recovered.error, undefined, recovered.text);
  assert.equal(fixture.clickCount(), 2);
});

test('an SDK element refusal preserves a valid frame for a different target', async (t) => {
  const fixture = selectedDriver('win32', 'refused-element');
  t.after(() => fixture.selected.backend?.dispose?.());
  const frame = await fixture.observe();
  const refused = await fixture.invoke({
    action: 'click_element',
    observation_id: frame.observation_id,
    element_id: frame.elements[0]!.element_id,
  });
  assert.equal(refused.error, 'dispatch_refused');
  assert.equal(refused.computerUse?.outcome.execution, 'not_started');
  assert.match(refused.modelText ?? refused.text, /still current/);
  assert.equal(fixture.selected.tools.sessionEvents.snapshot('task').status, 'active');
  assert.equal(fixture.snapshotCount(), 1);
  const corrected = await fixture.invoke({
    action: 'click_element',
    observation_id: frame.observation_id,
    element_id: frame.elements[1]!.element_id,
  });
  assert.equal(corrected.error, undefined, corrected.text);
  assert.equal(fixture.clickCount(), 2);
});

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: selected backend preserves dispatch evidence when the clicked window closes`, async (t) => {
    const fixture = selectedDriver(platform, 'closed');
    t.after(() => fixture.selected.backend?.dispose?.());
    const frame = await fixture.observe();
    const action = {
      action: 'click_element',
      observation_id: frame.observation_id,
      element_id: frame.elements[0]!.element_id,
    };
    const result = await fixture.invoke(action);
    assert.equal(result.error, 'outcome_unknown', result.text);
    assert.match(result.modelText ?? result.text, /effect=confirmed/);
    assert.match(result.modelText ?? result.text, /delivery=background/);
    assert.match(result.modelText ?? result.text, /Do not send it again/);
    assert.equal(result.computerUse?.outcome.execution, 'attempted');
    const replay = await fixture.invoke(action);
    assert.ok(replay.error, replay.text);
    assert.equal(replay.computerUse?.outcome.execution, 'not_started');
    assert.equal(fixture.clickCount(), 1);
  });

  test(`${platform}: selected backend recovers a transient after-frame failure with a fresh token`, async (t) => {
    const fixture = selectedDriver(platform, 'transient');
    t.after(() => fixture.selected.backend?.dispose?.());
    const frame = await fixture.observe();
    const action = {
      action: 'click_element',
      observation_id: frame.observation_id,
      element_id: frame.elements[0]!.element_id,
    };
    const result = await fixture.invoke(action);
    assert.equal(result.error, undefined, result.text);
    const fresh = parseObservationText(result.modelText ?? result.text);
    assert.ok(fresh, result.modelText ?? result.text);
    assert.notEqual(fresh.observation_id, frame.observation_id);
    assert.notEqual(fresh.elements[0]!.element_id, frame.elements[0]!.element_id);
    assert.ok((await fixture.invoke(action)).error);
    assert.equal(fixture.clickCount(), 1);
    const next = await fixture.invoke({
      action: 'click_element',
      observation_id: fresh.observation_id,
      element_id: fresh.elements[0]!.element_id,
    });
    assert.equal(next.error, undefined, next.text);
    assert.equal(fixture.clickCount(), 2);
  });

  test(`${platform}: observing the same window in another task still invalidates the old token`, async (t) => {
    const fixture = selectedDriver(platform, 'available');
    t.after(() => fixture.selected.backend?.dispose?.());
    const frame = await fixture.observe('first-task');
    await fixture.observe('second-task');
    assert.equal(
      fixture.selected.tools.sessionEvents.snapshot('first-task').status,
      'reobserve_required',
    );
    const result = await fixture.invoke(
      {
        action: 'click_element',
        observation_id: frame.observation_id,
        element_id: frame.elements[0]!.element_id,
      },
      'first-task',
    );
    assert.equal(result.computerUse?.outcome.execution, 'not_started');
    assert.ok(result.error, result.text);
    assert.equal(fixture.clickCount(), 0);
  });

  test(`${platform}: a sequence retains its delivered first step and stops after the window closes`, async (t) => {
    const fixture = selectedDriver(platform, 'closed');
    t.after(() => fixture.selected.backend?.dispose?.());
    const frame = await fixture.observe();
    const result = await fixture.invoke({
      action: 'element_sequence',
      observation_id: frame.observation_id,
      steps: [{ label: 'Close' }, { label: 'Close' }],
    });
    assert.equal(result.error, 'capture_failed', result.text);
    assert.match(result.modelText ?? result.text, /1\. ok/);
    assert.equal(fixture.clickCount(), 1);
  });
}
