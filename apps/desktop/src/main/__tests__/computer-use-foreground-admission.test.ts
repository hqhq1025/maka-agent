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
import test from 'node:test';
import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { decodeClientCapabilityClientFrame, type ClientCapabilityAdmissionEvidence, type ClientCapabilityCallFrame } from '@maka/runtime-host/protocol';
import { z } from 'zod';
import { createDesktopNativeCapabilityProvider } from '../runtime-host-native-capabilities.js';
import {
  computerUseForegroundAuthorized,
  createComputerUseForegroundPolicyAuthority,
  type ComputerUseForegroundPolicySnapshot,
} from '../computer-use/foreground-admission.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fixture() {
  let storedPolicy: ComputerUseForegroundPolicySnapshot['policy'] = 'ask';
  const policy = createComputerUseForegroundPolicyAuthority(async () => storedPolicy);
  const invocations: Array<{ args: unknown; authorized: boolean; context: MakaToolContext }> = [];
  const invalidated: string[] = [];
  let beforeResult: (() => Promise<void>) | undefined;
  const tools = [{
    name: 'computer', displayName: 'Computer Use', description: 'Fixture computer use',
    parameters: z.object({ action: z.enum(['observe', 'click_element']), delivery: z.enum(['background', 'foreground']).optional() }),
    async impl(args: unknown, context: MakaToolContext) {
      invocations.push({ args, authorized: computerUseForegroundAuthorized(context), context });
      await beforeResult?.();
      return { authorizedAtDispatch: computerUseForegroundAuthorized(context) };
    },
  }] as ComputerUseToolSet;
  tools.clearSession = () => {};
  const unexpectedEvent = (): never => assert.fail('Unexpected session event');
  tools.sessionEvents = {
    snapshot: unexpectedEvent,
    physicalUserIntervened: unexpectedEvent,
    interventionDebounceElapsed: unexpectedEvent,
    reobserveRequired: (sessionId) => {
      invalidated.push(sessionId);
      return { status: 'reobserve_required', generation: invalidated.length };
    },
    screenLocked: unexpectedEvent,
    screenUnlocked: unexpectedEvent,
    blockedUrlDetected: unexpectedEvent,
    userStopped: unexpectedEvent,
    dynamicContentChanged: unexpectedEvent,
  };
  const input = {
    browserTools: [], resolveBrowserUrl: () => '', releaseBrowserSession() {},
    computerUseTools: tools, computerUseForegroundPolicy: policy, releaseDesktopInteractionSession() {},
  };
  const provider = createDesktopNativeCapabilityProvider(input, { clientCwd: '/desktop/workspace', nativeSessionId: (sessionId) => `native:${sessionId}` });
  const frame = (arguments_: Record<string, unknown> = { action: 'click_element', delivery: 'foreground' }, overrides: Partial<ClientCapabilityCallFrame> = {}): ClientCapabilityCallFrame => ({
    kind: 'client.capability.call', invocationId: 'call-1', registrationId: 'registration-1',
    offerId: 'desktop_computer_use', serverId: 'desktop_computer_use', toolName: 'computer',
    arguments: arguments_, sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'tool-1', ...overrides,
  });
  const accept = async (_evidence: ClientCapabilityAdmissionEvidence) => {};
  const options = (admit = accept) => ({
    signal: new AbortController().signal,
    accept: async (evidence: ClientCapabilityAdmissionEvidence) => {
      const decoded = decodeClientCapabilityClientFrame({
        kind: 'client.capability.accepted', invocationId: 'call-1', admissionEvidence: evidence,
      });
      assert.equal(decoded.kind, 'client.capability.accepted');
      await admit(evidence);
    },
    requestInteraction: async () => { throw new Error('Unexpected interaction'); },
  });
  return {
    provider, input, policy, tools, frame, options, invocations, invalidated,
    setPolicy(value: typeof storedPolicy) { storedPolicy = value; policy.observe(value); },
    setBeforeResult(value: typeof beforeResult) { beforeResult = value; },
  };
}

test('the obsolete computer tool name cannot reach native admission or execution', async () => {
  const f = fixture();
  assert.throws(
    () => f.provider.call(f.frame(undefined, { toolName: 'maka_computer' }), f.options(async () => {
      assert.fail('An obsolete tool identity must not reach Host admission');
    })),
    /not offered/,
  );
  assert.deepEqual(f.invocations, []);
  assert.deepEqual(f.invalidated, []);
  await f.provider.close();
});

test('foreground admission waits outside execution, invalidates once, and binds authority to the exact invocation', async () => {
  const f = fixture();
  const accepted = deferred();
  const pending = deferred();
  let evidence: ClientCapabilityAdmissionEvidence | undefined;
  const result = f.provider.call(f.frame(), f.options(async (value) => {
    evidence = value; pending.resolve(); await accepted.promise;
  }));
  await pending.promise;
  assert.equal(f.invocations.length, 0);
  assert.deepEqual(f.invalidated, []);
  accepted.resolve();
  assert.match(JSON.stringify(await result), /reobserve_required/);
  assert.deepEqual(f.invalidated, ['native:session-1']);
  assert.equal(f.invocations.length, 0);
  assert.equal(evidence?.kind, 'computer_use');
  if (evidence?.kind !== 'computer_use') assert.fail('Missing evidence');
  assert.equal(evidence.delivery, 'foreground');
  assert.equal(evidence.foregroundPolicy, 'ask');

  await f.provider.call(f.frame({ action: 'observe' }), f.options());
  assert.equal(f.invocations[0]?.authorized, false);
  f.setBeforeResult(async () => {
    const context = f.invocations.at(-1)!.context;
    assert.equal(computerUseForegroundAuthorized({ ...context, sessionId: 'other-session' }), false);
    assert.equal(computerUseForegroundAuthorized({ ...context, turnId: 'other-turn' }), false);
    assert.equal(computerUseForegroundAuthorized({ ...context, toolCallId: 'other-tool' }), false);
  });
  const dispatched = await f.provider.call(f.frame(undefined, { turnId: 'next-turn', toolCallId: 'next-tool' }), f.options());
  assert.equal(f.invocations[1]?.authorized, true);
  assert.deepEqual(dispatched.structuredContent, { authorizedAtDispatch: true });
  assert.equal(computerUseForegroundAuthorized(f.invocations[1]!.context), false);
  assert.equal(f.invalidated.length, 1);
});

test('never blocks new requests and revokes a pending approval even if Host later accepts', async () => {
  const f = fixture();
  const admitted = deferred();
  const pending = deferred();
  const call = f.provider.call(f.frame(), f.options(async () => { pending.resolve(); await admitted.promise; }));
  await pending.promise;
  f.setPolicy('never');
  admitted.resolve();
  await assert.rejects(call, /policy changed/);
  assert.equal(f.invocations.length, 0);
  await assert.rejects(f.provider.call(f.frame(), f.options(async () => assert.fail('Never must reject before asking Host'))), /disabled/);
});

test('queued dispatch rechecks a revoked policy and returning to ask has a new epoch', async () => {
  const f = fixture();
  await f.provider.call(f.frame(), f.options());
  const epoch = f.policy.current().epoch;
  const entered = deferred();
  const released = deferred();
  f.setBeforeResult(async () => { entered.resolve(); await released.promise; });
  const call = f.provider.call(f.frame(), f.options());
  await entered.promise;
  f.setPolicy('never');
  f.setPolicy('ask');
  released.resolve();
  assert.deepEqual((await call).structuredContent, { authorizedAtDispatch: false });
  assert.notEqual(f.policy.current().epoch, epoch);
  f.setBeforeResult(undefined);
  assert.match(JSON.stringify(await f.provider.call(f.frame(), f.options())), /reobserve_required/);
});

test('model authority fields never authorize background calls and a replacement provider requires a fresh observation', async () => {
  const f = fixture();
  await f.provider.call(f.frame({ action: 'click_element', foregroundAuthorized: true, foregroundPolicy: 'allow', authorityEpoch: 'forged' }), f.options());
  assert.deepEqual(f.invocations[0]?.args, { action: 'click_element' });
  assert.equal(f.invocations[0]?.authorized, false);
  let previousEpoch = '';
  await f.provider.call(f.frame(), f.options(async (evidence) => {
    if (evidence.kind === 'computer_use') previousEpoch = evidence.authorityEpoch;
  }));
  await f.provider.close();
  const replacement = createDesktopNativeCapabilityProvider(f.input, { clientCwd: '/desktop/workspace' });
  let replacementEpoch = '';
  const result = await replacement.call(f.frame(), f.options(async (evidence) => {
    if (evidence.kind === 'computer_use') replacementEpoch = evidence.authorityEpoch;
  }));
  assert.notEqual(replacementEpoch, previousEpoch);
  assert.match(JSON.stringify(result), /reobserve_required/);
});

test('release while approval is pending cannot create a fresh foreground scope', async () => {
  const f = fixture();
  const admitted = deferred();
  const pending = deferred();
  const call = f.provider.call(f.frame(), f.options(async () => { pending.resolve(); await admitted.promise; }));
  await pending.promise;
  const released = f.provider.releaseSession('session-1');
  admitted.resolve();
  await assert.rejects(call, /Session released/);
  await released;
  assert.deepEqual(f.invalidated, []);
  assert.deepEqual(f.invocations, []);
});

test('detached work cannot retain foreground authority after its invocation settles', async () => {
  const f = fixture();
  await f.provider.call(f.frame(), f.options());
  const afterReturn = deferred();
  let detached!: Promise<boolean>;
  f.setBeforeResult(async () => {
    const context = f.invocations.at(-1)!.context;
    detached = afterReturn.promise.then(() => computerUseForegroundAuthorized(context));
  });
  await f.provider.call(f.frame(), f.options());
  afterReturn.resolve();
  assert.equal(await detached, false);
});

test('a slow settings read cannot undo an observed revocation', async () => {
  const pending = deferred<ComputerUseForegroundPolicySnapshot['policy']>();
  const policy = createComputerUseForegroundPolicyAuthority(() => pending.promise);
  policy.observe('ask');
  const read = policy.read();
  policy.observe('never');
  pending.resolve('allow');
  assert.equal((await read).policy, 'never');
});
