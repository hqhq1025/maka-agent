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
import { buildComputerUseTools } from '../computer-use-tools.js';
import { computerParams } from '../computer-use-codec.js';
import { computerWireParams } from '../computer-use-tools.js';
import type {
  CuDispatchBackend,
  CuDispatchOutcome,
  CuObservation,
  CuRunContext,
  CuSemanticAction,
} from '../computer-use-types.js';
import type { MakaToolContext } from '../tool-runtime.js';

function context(toolCallId = 'input'): MakaToolContext {
  return {
    sessionId: 'pixel-session',
    turnId: 'pixel-turn',
    toolCallId,
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

function observation(withScreenshot = true): CuObservation {
  return {
    observationId: 'native-screenshot',
    appId: 'Writer',
    pid: 42,
    windowId: 7,
    // These screen/source bounds must not become screenshot pixel authority.
    windowBounds: { x: 500, y: 200, width: 800, height: 600 },
    sourceBoundsPx: { x: 0, y: 0, width: 800, height: 600 },
    ...(withScreenshot
      ? {
          screenshot: {
            base64: 'cG5n',
            mimeType: 'image/png' as const,
            widthPx: 100,
            heightPx: 80,
          },
        }
      : {}),
    elements: [],
  };
}

function fixture(withScreenshot = true) {
  const calls: Array<{ action: CuSemanticAction; context: CuRunContext }> = [];
  let outcome: CuDispatchOutcome = { ok: true, tier: 'coordinate-background', verified: false };
  const backend: CuDispatchBackend = {
    supportedActions: ['observe', 'type', 'press_key'],
    supportedForegroundActions: ['type', 'press_key'],
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return observation(withScreenshot);
    },
    async run() {
      assert.fail('pixel text input must retain semantic dispatch authority');
    },
    async runSemantic(action, _signal, runContext) {
      await runContext.beforeNativeDispatch?.();
      calls.push({ action, context: runContext });
      if (action.delivery === 'foreground' && !runContext.foregroundAuthorized) {
        return {
          outcome: {
            ok: false,
            error: 'policy_denied',
            message: 'No grant.',
            evidence: { path: 'none' },
          },
        };
      }
      return { outcome, observation: observation(withScreenshot) };
    },
  };
  return {
    backend,
    calls,
    setOutcome(next: CuDispatchOutcome) {
      outcome = next;
    },
  };
}

type ComputerTool = ReturnType<typeof buildComputerUseTools>[0];
async function observe(tool: ComputerTool): Promise<string> {
  const result = (await tool.impl(
    { action: 'observe', app: 'Writer', window_id: 7, include_screenshot: true },
    context('observe'),
  )) as { text: string };
  return JSON.parse(result.text).observation_id;
}

test('pixel type and keys retain the exact observation, delivery, and window without guessing a screen point', async () => {
  for (const action of ['type', 'press_key'] as const) {
    for (const delivery of [undefined, 'foreground'] as const) {
      const { backend, calls } = fixture();
      const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
      const observationId = await observe(tool);
      await tool.impl(
        {
          action,
          observation_id: observationId,
          coordinate: [99, 79],
          text: 'Return',
          ...(delivery ? { delivery } : {}),
        },
        context(),
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.action, {
        type: action,
        observationId: 'native-screenshot',
        coordinate: [99, 79],
        ...(action === 'type' ? { text: 'Return' } : { key: 'Return' }),
        ...(delivery ? { delivery } : {}),
      });
      const binding = calls[0]?.context.boundAction;
      assert.equal(binding?.frameId, observationId);
      assert.equal(binding?.target.pid, 42);
      assert.equal(binding?.target.windowId, 7);
      assert.equal(binding?.elementId, undefined);
      assert.equal(binding?.presentationScreenPoint, undefined);
    }
  }
});

test('pixel input requires an actual screenshot and uses its dimensions rather than source or window bounds', async () => {
  for (const scenario of [
    { screenshot: false, coordinate: [0, 0], error: 'capture_failed' },
    { screenshot: true, coordinate: [100, 0], error: 'invalid_coordinate' },
    { screenshot: true, coordinate: [0, 80], error: 'invalid_coordinate' },
  ]) {
    const { backend, calls } = fixture(scenario.screenshot);
    const [tool] = buildComputerUseTools({ backend });
    const observationId = await observe(tool);
    const result = (await tool.impl(
      {
        action: 'type',
        observation_id: observationId,
        coordinate: scenario.coordinate,
        text: 'hello',
      },
      context(),
    )) as { error?: string; text: string };
    assert.equal(calls.length, 0);
    assert.equal(result.error, scenario.error);
    assert.match(result.text, /No input was sent/);
  }
});

test('unknown pixel input consumes its old observation and never upgrades delivery automatically', async () => {
  const { backend, calls, setOutcome } = fixture();
  setOutcome({
    ok: false,
    error: 'outcome_unknown',
    message: 'Native delivery is unresolved.',
    evidence: { path: 'native_input', effect: 'unverifiable' },
  });
  const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
  const observationId = await observe(tool);
  const input = {
    action: 'type',
    observation_id: observationId,
    coordinate: [25, 30],
    text: 'hello',
  };
  const result = (await tool.impl(input, context('first'))) as { error?: string };
  assert.equal(result.error, 'outcome_unknown');
  const repeated = (await tool.impl(input, context('repeat'))) as { error?: string };
  assert.equal(repeated.error, 'reobserve_required');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.action.delivery, undefined);
});

test('refusing one screenshot point retires only that action and does not authorize foreground reuse', async () => {
  const { backend, calls, setOutcome } = fixture();
  setOutcome({
    ok: false,
    error: 'dispatch_refused',
    message: 'No input sent.',
    evidence: { path: 'none' },
  });
  const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
  const observationId = await observe(tool);
  const input = {
    action: 'press_key',
    observation_id: observationId,
    coordinate: [25, 30],
    text: 'Return',
  };
  await tool.impl(input, context('refused'));
  const repeated = (await tool.impl(
    { ...input, delivery: 'foreground' },
    context('foreground'),
  )) as { error?: string };
  assert.equal(repeated.error, 'duplicate_action');
  await tool.impl({ ...input, coordinate: [26, 30] }, context('different-point'));
  assert.equal(calls.length, 2, 'coordinates must participate in the consumed-action fingerprint');
});

test('coordinates are snapshotted before an asynchronous preflight', async () => {
  const { backend, calls } = fixture();
  const [tool] = buildComputerUseTools({ backend });
  const observationId = await observe(tool);
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const preflightReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.preflight = async () => {
    entered();
    await preflightReady;
    return { accessibility: true, screenRecording: true };
  };
  const coordinate = [25, 30];
  const pending = tool.impl(
    { action: 'type', observation_id: observationId, coordinate, text: 'hello' },
    context(),
  );
  await enteredPromise;
  coordinate[0] = 500;
  release();
  await pending;
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]?.action.type === 'type' ? calls[0].action.coordinate : undefined,
    [25, 30],
  );
});

test('a superseded screenshot and a conflicting window hint cannot dispatch pixel input', async () => {
  const { backend, calls } = fixture();
  const [tool] = buildComputerUseTools({ backend });
  const oldId = await observe(tool);
  const currentId = await observe(tool);
  const stale = (await tool.impl(
    { action: 'type', observation_id: oldId, coordinate: [0, 0], text: 'hello' },
    context(),
  )) as { error?: string };
  assert.equal(stale.error, 'stale_frame');
  const wrongWindow = (await tool.impl(
    { action: 'type', observation_id: currentId, window_id: 8, coordinate: [0, 0], text: 'hello' },
    context(),
  )) as { error?: string };
  assert.equal(wrongWindow.error, 'target_mismatch');
  assert.equal(calls.length, 0);
});

test('current-focus Ctrl+A and typing retain the exact window without refocusing after the fresh observation', async () => {
  const { backend, calls } = fixture();
  const original = backend.runSemantic!;
  let selected = false;
  let value = 'old content';
  backend.runSemantic = async (action, signal, runContext) => {
    const result = await original(action, signal, runContext);
    assert.equal('focus' in action && action.focus, 'current');
    assert.equal('coordinate' in action, false);
    assert.equal('elementId' in action, false);
    if (action.type === 'press_key' && action.key === 'ctrl+a') selected = true;
    if (action.type === 'type') value = selected ? action.text : value + action.text;
    return result;
  };
  const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
  const first = await observe(tool);
  await tool.impl(
    {
      action: 'press_key',
      observation_id: first,
      focus: 'current',
      delivery: 'foreground',
      text: 'ctrl+a',
    },
    context('select'),
  );
  const fresh = await observe(tool);
  assert.notEqual(fresh, first);
  await tool.impl(
    {
      action: 'type',
      observation_id: fresh,
      focus: 'current',
      delivery: 'foreground',
      text: 'replacement',
    },
    context('replace'),
  );
  assert.equal(value, 'replacement');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.context.foregroundAuthorized, true);
    assert.equal(call.context.boundAction?.target.pid, 42);
    assert.equal(call.context.boundAction?.target.windowId, 7);
    assert.equal(call.context.boundAction?.presentationScreenPoint, undefined);
  }
});

test('current-focus input rejects mixed targets and absent foreground in both schemas before dispatch', async () => {
  const { backend, calls } = fixture();
  backend.preflight = async () => assert.fail('invalid focus calls must fail before preflight');
  const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
  for (const action of ['type', 'press_key']) {
    for (const extra of [
      { delivery: undefined },
      { delivery: 'background' },
      { element_id: '3' },
      { coordinate: [25, 30] },
      { focus: 'unverified' },
    ]) {
      const input = {
        action,
        observation_id: 'o',
        focus: 'current',
        delivery: 'foreground',
        text: 'hello',
        ...extra,
      };
      assert.equal(computerWireParams.safeParse(input).success, false);
      assert.equal(computerParams.safeParse(input).success, false);
      await assert.rejects(() => Promise.resolve(tool.impl(input, context())));
    }
  }
  assert.equal(calls.length, 0);
});

test('current-focus input requires a screenshot and cannot inherit a foreground grant from model args', async () => {
  for (const screenshot of [false, true]) {
    const { backend, calls } = fixture(screenshot);
    const [tool] = buildComputerUseTools({ backend });
    const observationId = await observe(tool);
    const result = (await tool.impl(
      {
        action: 'type',
        observation_id: observationId,
        focus: 'current',
        delivery: 'foreground',
        text: 'hello',
      },
      context(),
    )) as { error?: string };
    assert.equal(result.error, screenshot ? 'policy_denied' : 'capture_failed');
    if (screenshot) assert.equal(calls[0]?.context.foregroundAuthorized, false);
    else assert.equal(calls.length, 0);
  }
});

test('unknown current-focus delivery consumes the observation and blocks replay', async () => {
  const { backend, calls, setOutcome } = fixture();
  setOutcome({
    ok: false,
    error: 'outcome_unknown',
    message: 'No authoritative result.',
    evidence: { path: 'native_input', effect: 'unverifiable' },
  });
  const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
  const observationId = await observe(tool);
  const input = {
    action: 'type',
    observation_id: observationId,
    focus: 'current',
    delivery: 'foreground',
    text: 'hello',
  };
  assert.equal(
    ((await tool.impl(input, context('first'))) as { error?: string }).error,
    'outcome_unknown',
  );
  assert.equal(
    ((await tool.impl(input, context('repeat'))) as { error?: string }).error,
    'reobserve_required',
  );
  assert.equal(calls.length, 1);
});
