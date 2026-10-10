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
import { computerUseModelCallArgs } from '@maka/core/computer-use';
import { computerParams } from '../computer-use-codec.js';
import {
  buildComputerUseTools,
  computerWireParams,
  type CuDispatchBackend,
  type CuObservation,
  type CuRunContext,
  type CuSemanticAction,
} from '../computer-use-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

const semanticInputs = [
  { action: 'click_element', element_id: '5' },
  { action: 'double_click_element', element_id: '5' },
  { action: 'set_value', element_id: '5', value: '玛卡' },
  { action: 'type', element_id: '5', text: 'A new paragraph.\n第二段。' },
  { action: 'press_key', element_id: '5', text: 'Return' },
  { action: 'scroll_element', element_id: '5', scroll_direction: 'down' },
  { action: 'secondary_action', element_id: '5', text: 'AXShowMenu' },
] as const;

function context(toolCallId = 'input'): MakaToolContext {
  return {
    sessionId: 'foreground-session',
    turnId: 'foreground-turn',
    toolCallId,
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}

function observation(): CuObservation {
  return {
    observationId: 'native-observation',
    appId: 'Fixture',
    pid: 42,
    windowId: 7,
    contentFingerprint: 'fixture-content',
    elements: [
      {
        elementId: '5',
        role: 'AXButton',
        label: 'Continue',
        frame: { x: 20, y: 20, width: 80, height: 30 },
        identity: { token: 'continue-token', role: 'AXButton', label: 'Continue' },
      },
    ],
  };
}

function backendFixture() {
  const calls: Array<{ action: CuSemanticAction; context: CuRunContext }> = [];
  const backend: CuDispatchBackend = {
    supportedActions: ['observe', ...semanticInputs.map(({ action }) => action)],
    supportedForegroundActions: semanticInputs.map(({ action }) => action),
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async observeApp() {
      return observation();
    },
    async run() {
      assert.fail('semantic input must use the semantic dispatch seam');
    },
    async runSemantic(action, _signal, runContext) {
      await runContext.beforeNativeDispatch?.();
      calls.push({ action, context: runContext });
      if (action.delivery === 'foreground' && !runContext.foregroundAuthorized) {
        return {
          outcome: {
            ok: false,
            error: 'policy_denied',
            message: 'Foreground task permission is absent.',
            evidence: { path: 'none' },
          },
        };
      }
      return {
        outcome: { ok: true, tier: 'ax', verified: true },
        observation: observation(),
      };
    },
  };
  return { backend, calls };
}

type ComputerTool = ReturnType<typeof buildComputerUseTools>[0];

async function observe(tool: ComputerTool): Promise<string> {
  const result = (await tool.impl({ action: 'observe', app: 'Fixture' }, context('observe'))) as {
    text: string;
  };
  return JSON.parse(result.text).observation_id;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('delivery choices survive both model schemas and history projection for semantic input', () => {
  for (const input of semanticInputs) {
    for (const delivery of ['background', 'foreground'] as const) {
      const args = { ...input, observation_id: 'observation-1', delivery };
      assert.equal(computerWireParams.safeParse(args).success, true, input.action);
      assert.equal(computerParams.safeParse(args).success, true, input.action);
      assert.equal(computerUseModelCallArgs(args).delivery, delivery, input.action);
    }
  }
});

test('models cannot inject host authority or give non-input actions a delivery mode', async () => {
  let preflights = 0;
  const { backend, calls } = backendFixture();
  backend.preflight = async () => {
    preflights += 1;
    return { accessibility: true, screenRecording: true };
  };
  const [tool] = buildComputerUseTools({ backend });
  const injected = {
    action: 'click_element',
    observation_id: 'observation-1',
    element_id: '5',
    delivery: 'foreground',
    foregroundAuthorized: true,
  };
  assert.equal(computerWireParams.safeParse(injected).success, false);
  assert.equal(computerParams.safeParse(injected).success, false);

  for (const args of [
    injected,
    { action: 'observe', app: 'Fixture', delivery: 'foreground' },
    {
      action: 'window_action',
      observation_id: 'observation-1',
      element_id: '5',
      window_action: 'move',
      position: [10, 20],
      delivery: 'foreground',
    },
    {
      action: 'element_sequence',
      observation_id: 'observation-1',
      steps: [{ label: 'Continue' }],
      delivery: 'foreground',
    },
  ]) {
    await assert.rejects(() => Promise.resolve(tool.impl(args as never, context())));
  }
  assert.equal(preflights, 0);
  assert.equal(calls.length, 0);
});

test('an unadvertised foreground action is refused before preflight or dispatch', async () => {
  for (const supportedForegroundActions of [undefined, ['press_key']]) {
    const { backend, calls } = backendFixture();
    backend.supportedForegroundActions = supportedForegroundActions;
    backend.preflight = async () => assert.fail('unsupported input must not reach preflight');
    const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: 'not-yet-observed',
        element_id: '5',
        delivery: 'foreground',
      },
      context(),
    )) as { error?: string };
    assert.equal(result.error, 'unsupported_action');
    assert.equal(calls.length, 0);
  }
});

test('foreground delivery reaches every supported semantic action with exact trusted task identity', async () => {
  for (const input of semanticInputs) {
    const { backend, calls } = backendFixture();
    const approvals: Array<Pick<CuRunContext, 'sessionId' | 'turnId' | 'toolCallId'>> = [];
    const [tool] = buildComputerUseTools({
      backend,
      foregroundAuthorized(runContext) {
        approvals.push({
          sessionId: runContext.sessionId,
          turnId: runContext.turnId,
          toolCallId: runContext.toolCallId,
        });
        return true;
      },
    });
    const observationId = await observe(tool);
    await tool.impl(
      { ...input, observation_id: observationId, delivery: 'foreground' },
      context(input.action),
    );
    assert.equal(calls.length, 1, input.action);
    assert.equal(calls[0]?.action.type, input.action);
    assert.equal(calls[0]?.action.delivery, 'foreground');
    assert.equal(calls[0]?.context.foregroundAuthorized, true);
    assert.equal(approvals.length, 2, 'authority is checked before and after presentation');
    for (const approval of approvals)
      assert.deepEqual(approval, {
        sessionId: 'foreground-session',
        turnId: 'foreground-turn',
        toolCallId: input.action,
      });
    assert.equal(calls[0]?.context.sessionId, approvals[0]?.sessionId);
    assert.equal(calls[0]?.context.turnId, approvals[0]?.turnId);
    assert.equal(calls[0]?.context.toolCallId, approvals[0]?.toolCallId);
    assert.equal(calls[0]?.context.boundAction?.target.windowId, 7);
  }
});

test('omitting the host permission hook denies foreground without changing default delivery', async () => {
  for (const delivery of [undefined, 'foreground'] as const) {
    const { backend, calls } = backendFixture();
    const [tool] = buildComputerUseTools({ backend });
    const observationId = await observe(tool);
    const result = (await tool.impl(
      {
        action: 'click_element',
        observation_id: observationId,
        element_id: '5',
        ...(delivery ? { delivery } : {}),
      },
      context(),
    )) as { error?: string };
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action.delivery, delivery);
    assert.equal(calls[0]?.context.foregroundAuthorized, false);
    assert.equal(result.error, delivery === 'foreground' ? 'policy_denied' : undefined);
  }
});

test('foreground authority is sampled after presentation readiness, so revocation cannot go stale', async () => {
  const { backend, calls } = backendFixture();
  const entered = deferred();
  const ready = deferred();
  let authorized = true;
  let authorityReads = 0;
  const [tool] = buildComputerUseTools({
    backend,
    foregroundAuthorized() {
      authorityReads += 1;
      return authorized;
    },
    overlay: {
      onActionBegin() {
        entered.resolve();
        return { readyForInteraction: ready.promise, finished: Promise.resolve() };
      },
    },
    presentationReadyTimeoutMs: 10_000,
  });
  const observationId = await observe(tool);
  const pending = tool.impl(
    {
      action: 'click_element',
      observation_id: observationId,
      element_id: '5',
      delivery: 'foreground',
    },
    context(),
  );
  await entered.promise;
  assert.equal(calls.length, 0);
  assert.equal(authorityReads, 1);
  authorized = false;
  ready.resolve();
  const result = (await pending) as { error?: string };
  assert.equal(authorityReads, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.action.delivery, 'foreground');
  assert.equal(calls[0]?.context.foregroundAuthorized, false);
  assert.equal(result.error, 'policy_denied');
});

test('foreground retry requires a fresh observation even when task authority is already granted', async () => {
  const { backend, calls } = backendFixture();
  const dispatch = backend.runSemantic!;
  backend.runSemantic = async (action, signal, runContext) => {
    if (action.delivery !== 'foreground') {
      calls.push({ action, context: runContext });
      return {
        outcome: {
          ok: false,
          error: 'dispatch_refused',
          message: 'Background input is unsupported by this control.',
          evidence: { path: 'none' },
        },
      };
    }
    return dispatch(action, signal, runContext);
  };
  const [tool] = buildComputerUseTools({ backend, foregroundAuthorized: () => true });
  const observationId = await observe(tool);
  const input = {
    action: 'click_element' as const,
    observation_id: observationId,
    element_id: '5',
  };
  const background = (await tool.impl(input, context('background'))) as { error?: string };
  assert.equal(background.error, 'dispatch_refused');
  assert.equal(calls.length, 1);

  const staleRetry = (await tool.impl(
    { ...input, delivery: 'foreground' },
    context('stale-foreground'),
  )) as { error?: string };
  assert.equal(staleRetry.error, 'duplicate_action');
  assert.equal(calls.length, 1);

  const freshId = await observe(tool);
  assert.notEqual(freshId, observationId);
  const freshRetry = (await tool.impl(
    { ...input, observation_id: freshId, delivery: 'foreground' },
    context('fresh-foreground'),
  )) as { error?: string };
  assert.equal(freshRetry.error, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.action.delivery, 'foreground');
  assert.equal(calls[1]?.context.foregroundAuthorized, true);
});
