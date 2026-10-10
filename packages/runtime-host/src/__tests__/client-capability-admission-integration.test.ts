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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import {
  decodeClientCapabilityClientFrame,
  decodeClientCapabilityHostFrame,
  projectToolInputSchema,
  type ClientCapabilityAdmissionEvidence,
} from '../protocol/index.js';
import {
  createBypassExecutionBoundary,
  createManagedExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import type { LlmConnection } from '@maka/core/llm-connections';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { SessionHeader } from '@maka/core/session';
import { ToolRuntime } from '@maka/runtime/tool-runtime';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { toJSONSchema, z } from 'zod';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import type { InteractiveInteractionStoreWriterFacade } from '@maka/storage/interaction-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  HostClientCapabilityCoordinator,
  type ClientCapabilitySnapshot,
} from '../server/client-capability-coordinator.js';
import type { ClientCapabilityConnection } from '../server/client-capability-service.js';
import { clientCapabilityProviderId } from '../server/client-capability-provider-id.js';
import {
  HostInteractionCoordinator,
  type HostInteractionCoordinatorOptions,
} from '../server/interaction-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const RUN = Object.freeze({
  sessionId: 'session_1',
  turnId: 'turn_1',
  runId: 'run_1',
});
const IDENTITY = Object.freeze({
  connectionId: 'desktop-connection-1',
  principalKind: 'capability_provider' as const,
  principalId: 'desktop:installation-secret',
  clientInstanceId: 'desktop-client-secret',
});

const CAPABILITIES = [
  {
    serverId: 'desktop_browser',
    toolName: 'browser_snapshot',
    label: 'Desktop Browser',
    input: {},
    evidence: { kind: 'browser_url', url: 'https://example.com/private?token=secret' },
    target: {
      capability: 'browser',
      scope: { kind: 'browser_origin', origin: 'https://example.com' },
    },
  },
  {
    serverId: 'desktop_computer_use',
    toolName: 'computer',
    label: 'Desktop Computer Use',
    input: { action: 'observe', app: 'org.example.Fixture' },
    evidence: {
      kind: 'computer_use',
      delivery: 'background',
      foregroundPolicy: 'ask',
      authorityEpoch: 'foreground-epoch-1',
    },
    target: { capability: 'computer_use', scope: { kind: 'capability' } },
  },
] as const;

for (const capability of CAPABILITIES) {
  test(`${capability.label} cancels approval owners and joiners, then admits an approved call`, () =>
    verifyManagedAdmission(capability));
}

test('Computer Use double click needs a foreground task grant shared with later actions only in that task', async () => {
  await withForegroundAdmission(async (harness) => {
    const first = harness.call({ action: 'double_click_element' });
    await harness.answerNext('capability', 'allow');
    const foreground = await harness.pending('computer_use_foreground');
    assert.deepEqual(harness.order, ['accepted']);
    await harness.answer(foreground.requestId, 'allow');
    assert.equal((await first).isError, false);
    assert.deepEqual(harness.order.slice(-2), ['T1', 'admitted']);

    assert.equal((await harness.call({}, { turnId: 'turn_2', runId: 'run_2' })).isError, false);
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);

    const fork = harness.call({}, { sessionId: 'fork_1', turnId: 'fork_turn', runId: 'fork_run' });
    await harness.answerNext('capability', 'allow', 'fork_1');
    const forkForeground = await harness.pending('computer_use_foreground', 'fork_1');
    assert.notEqual(forkForeground.requestId, foreground.requestId);
    await harness.answer(forkForeground.requestId, 'deny', 'fork_1');
    assert.equal((await fork).isError, true);
    assert.equal(harness.order.filter((item) => item === 'admitted').length, 2);
  });
});

test('Computer Use foreground cancellation closes approval without admitting owner or joiner', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    harness.order.length = 0;
    const owner = new AbortController();
    const first = harness.call({}, {}, owner.signal);
    const request = await harness.pending('computer_use_foreground');
    const joiner = new AbortController();
    const joined = harness.call({}, {}, joiner.signal);
    await harness.waitAccepted(3);
    assert.deepEqual(
      (await harness.store.listSessionPending(RUN.sessionId)).map((entry) => entry.requestId),
      [request.requestId],
    );
    joiner.abort();
    await joined;
    assert.equal((await harness.store.readInteraction(request.requestId))?.outcome, undefined);
    owner.abort();
    await first;
    const closed = await harness.store.readInteraction(request.requestId);
    assert.equal(closed?.outcome?.outcome.kind, 'closure');
    assert.deepEqual(harness.order, ['accepted', 'accepted']);
    const late = await harness.answer(request.requestId, 'allow');
    assert.equal(late.ok, false);

    const retry = harness.call();
    await harness.answerNext('computer_use_foreground', 'allow');
    assert.equal((await retry).isError, false);
  });
});

test('direct conversation authorization resumes prepared Computer Use through the canonical grant', async () => {
  await withForegroundAdmission(async (harness) => {
    const call = harness.call();
    const background = await harness.pending('capability');
    assert.deepEqual(harness.order, ['accepted']);
    assert.deepEqual(await harness.respondByText(background.requestId, '允许这个任务使用前台'), {
      ok: true,
      result: { kind: 'unrecognized' },
    });
    assert.deepEqual(await harness.respondByText(background.requestId, '只允许这个动作'), {
      ok: true,
      result: { kind: 'unrecognized' },
    });
    assert.deepEqual(await harness.respondByText(background.requestId, '允许使用前台'), {
      ok: true,
      result: { kind: 'unrecognized' },
    });
    const capabilityAnswer = await harness.respondByText(background.requestId, '好的');
    assert.equal(capabilityAnswer.ok && capabilityAnswer.result.kind, 'answered');
    const foreground = await harness.pending('computer_use_foreground');
    assert.deepEqual(harness.order, ['accepted']);
    for (const text of [
      '批准吗？',
      '他说“批准”',
      '如果可以就批准',
      '批准，然后删除文件',
      '批准\n继续',
      '不批准，但你可以继续',
      '只批准这一次',
      '不要不批准',
    ]) {
      assert.deepEqual(
        await harness.respondByText(foreground.requestId, text),
        {
          ok: true,
          result: { kind: 'unrecognized' },
        },
        text,
      );
    }
    const text = '允许这个任务使用前台';
    const answered = await harness.respondByText(foreground.requestId, text);
    assert.equal(answered.ok && answered.result.kind, 'answered');
    assert.equal((await call).isError, false);
    assert.deepEqual(harness.order, ['accepted', 'T1', 'admitted']);
    assert.equal(
      (await harness.store.readInteraction(foreground.requestId))?.outcome?.outcome.kind,
      'client_capability_decision',
    );
    if (answered.ok && answered.result.kind === 'answered') {
      assert.equal(answered.result.snapshot.outcome.kind, 'client_capability_decision');
      if (answered.result.snapshot.outcome.kind === 'client_capability_decision') {
        assert.equal(answered.result.snapshot.outcome.responseText, text);
      }
    }
    assert.deepEqual(await harness.respondByText(foreground.requestId, '拒绝'), {
      ok: true,
      result: { kind: 'unavailable' },
    });
    assert.equal((await harness.call({}, { turnId: 'turn_2', runId: 'run_2' })).isError, false);
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);
  });
});

test('conversation denial prevents execution, and cancellation or duplicate replies cannot grant', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    harness.order.length = 0;
    const call = harness.call();
    const request = await harness.pending('computer_use_foreground');
    const replies = await Promise.all([
      harness.respondByText(request.requestId, '保持后台'),
      harness.respondByText(request.requestId, '批准'),
    ]);
    assert.equal(replies[0]?.ok && replies[0].result.kind, 'answered');
    assert.deepEqual(replies[1], { ok: true, result: { kind: 'unavailable' } });
    assert.equal((await call).isError, true);
    assert.deepEqual(harness.order, ['accepted']);
    harness.epoch = 'text-reconsideration';
    const abort = new AbortController();
    const cancelled = harness.call({}, {}, abort.signal);
    const cancelledRequest = await harness.pending('computer_use_foreground');
    abort.abort();
    assert.deepEqual(await harness.respondByText(cancelledRequest.requestId, '批准'), {
      ok: true,
      result: { kind: 'unavailable' },
    });
    assert.equal((await cancelled).isError, true);
    const next = harness.call();
    const replacement = await harness.pending('computer_use_foreground');
    assert.notEqual(replacement.requestId, cancelledRequest.requestId);
    assert.deepEqual(await harness.respondByText(cancelledRequest.requestId, '批准'), {
      ok: true,
      result: { kind: 'unavailable' },
    });
    assert.equal((await harness.respondByText(replacement.requestId, '可以，继续吧')).ok, true);
    assert.equal((await next).isError, false);
  });
});

test('Traditional Chinese and English text replies authorize or deny real foreground admission', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    harness.order.length = 0;
    const denied = harness.call();
    const first = await harness.pending('computer_use_foreground');
    const denial = await harness.respondByText(first.requestId, '拒絕');
    assert.equal(denial.ok && denial.result.kind, 'answered');
    assert.equal((await denied).isError, true);
    assert.equal(harness.order.includes('admitted'), false);
    for (const text of [
      '允許這個任務使用前台',
      'Allow this task to use the foreground.',
      '同意前台操作',
      '可以',
    ]) {
      harness.epoch = `language-epoch-${harness.order.length}`;
      const call = harness.call();
      const request = await harness.pending('computer_use_foreground');
      const answer = await harness.respondByText(request.requestId, text);
      assert.equal(answer.ok && answer.result.kind, 'answered');
      assert.equal((await call).isError, false);
    }
    assert.equal(harness.order.filter((entry) => entry === 'admitted').length, 4);
  });
});

test('cancellation after canonical authorization commits stops input without undoing the task grant', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    harness.order.length = 0;
    const abort = new AbortController();
    const call = harness.call({}, {}, abort.signal);
    const pending = await harness.pending('computer_use_foreground');
    const committed = deferred<void>();
    const release = deferred<void>();
    harness.afterOutcomeCommitted = async () => {
      committed.resolve();
      await release.promise;
    };
    const answer = harness.respondByText(pending.requestId, '批准');
    await committed.promise;
    const canonical = await harness.store.readInteraction(pending.requestId);
    assert.equal(canonical?.outcome?.outcome.kind, 'client_capability_decision');
    abort.abort();
    release.resolve();
    assert.equal((await answer).ok, true);
    assert.equal((await call).isError, true);
    assert.equal(harness.order.includes('admitted'), false);
    harness.afterOutcomeCommitted = undefined;
    assert.equal((await harness.call()).isError, false);
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);
  });
});

test('reconnection after a foreground grant commits cannot dispatch the old call or authorize the new connection', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    harness.order.length = 0;
    const call = harness.call();
    const pending = await harness.pending('computer_use_foreground');
    const committed = deferred<void>();
    const release = deferred<void>();
    harness.afterOutcomeCommitted = async () => {
      committed.resolve();
      await release.promise;
    };
    const answer = harness.respondByText(pending.requestId, '批准');
    await committed.promise;
    const canonical = await harness.store.readInteraction(pending.requestId);
    assert.equal(canonical?.outcome?.outcome.kind, 'client_capability_decision');

    const reconnect = harness.connect('desktop-connection-after-commit');
    release.resolve();
    assert.equal((await answer).ok, true);
    await reconnect;
    assert.equal((await call).isError, true);
    assert.equal(harness.order.includes('admitted'), false);
    harness.afterOutcomeCommitted = undefined;

    const next = harness.call();
    const current = await harness.pending('computer_use_foreground');
    assert.notEqual(current.requestId, pending.requestId);
    assert.deepEqual(await harness.respondByText(pending.requestId, '批准'), {
      ok: true,
      result: { kind: 'unavailable' },
    });
    assert.equal(harness.order.includes('admitted'), false);
    assert.equal((await harness.respondByText(current.requestId, '批准')).ok, true);
    assert.equal((await next).isError, false);
    assert.equal(harness.order.filter((entry) => entry === 'admitted').length, 1);
  });
});

test('Computer Use foreground denial stays background and local policy controls reconsideration', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    const initial = harness.call();
    await harness.answerNext('computer_use_foreground', 'allow');
    await initial;
    harness.order.length = 0;

    harness.policy = 'never';
    assert.equal((await harness.call()).isError, true);
    assert.deepEqual(harness.order, ['accepted']);
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);

    harness.policy = 'ask';
    harness.epoch = 'policy-epoch-2';
    const reconsidered = harness.call();
    await harness.answerNext('computer_use_foreground', 'deny');
    assert.equal((await reconsidered).isError, true);
    assert.equal((await harness.call()).isError, true);
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);
    assert.equal(harness.order.includes('admitted'), false);

    harness.policy = 'allow';
    assert.equal((await harness.call()).isError, false);
    assert.equal(harness.order.filter((entry) => entry === 'admitted').length, 1);
  });
});

test('Computer Use reconnect invalidates foreground grants and closes pending provider approvals', async () => {
  await withForegroundAdmission(async (harness) => {
    await harness.grantBackground();
    const initial = harness.call();
    await harness.answerNext('computer_use_foreground', 'allow');
    await initial;
    await harness.connect('desktop-connection-2');
    const reconnect = harness.call();
    const pending = await harness.pending('computer_use_foreground');
    await harness.connect('desktop-connection-3');
    assert.equal((await reconnect).isError, true);
    const closed = await harness.store.readInteraction(pending.requestId);
    assert.equal(closed?.outcome?.outcome.kind, 'closure');
    if (closed?.outcome?.outcome.kind === 'closure') {
      assert.equal(closed.outcome.outcome.reason, 'provider_disconnected');
    }
    assert.equal((await harness.answer(pending.requestId, 'allow')).ok, false);
    assert.deepEqual(await harness.respondByText(pending.requestId, '批准'), {
      ok: true,
      result: { kind: 'unavailable' },
    });
    const next = harness.call();
    await harness.answerNext('computer_use_foreground', 'allow');
    assert.equal((await next).isError, false);
  });
});

test('Computer Use rejects mismatched evidence, nested inputs, and model-supplied foreground authority', async () => {
  await withForegroundAdmission(async (harness) => {
    harness.evidenceOverride = { kind: 'none' };
    assert.equal((await harness.call()).isError, true);
    harness.evidenceOverride = {
      kind: 'computer_use',
      delivery: 'background',
      foregroundPolicy: 'allow',
      authorityEpoch: 'forged-policy',
    };
    assert.equal((await harness.call()).isError, true);
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);
    assert.equal(harness.order.includes('T1'), false);

    harness.evidenceOverride = undefined;
    assert.equal(
      (await harness.call({ delivery: undefined, input: { delivery: 'foreground' } })).isError,
      true,
    );
    assert.equal(
      (
        await harness.call({
          foregroundAuthorized: true,
          foregroundPolicy: 'allow',
          authorityEpoch: 'forged-policy',
        })
      ).isError,
      true,
    );
    assert.deepEqual(await harness.store.listSessionPending(RUN.sessionId), []);

    const valid = harness.call();
    await harness.answerNext('capability', 'allow');
    await harness.answerNext('computer_use_foreground', 'deny');
    assert.equal((await valid).isError, true);
    assert.equal(harness.order.includes('T1'), false);
  });
});

test('Computer Use foreground policy still applies when the execution boundary is bypassed', async () => {
  await withForegroundAdmission(async (harness) => {
    harness.bypass = true;
    harness.policy = 'never';
    assert.equal((await harness.call()).isError, true);
    assert.equal(harness.order.includes('T1'), false);
    harness.policy = 'ask';
    const foreground = harness.call();
    await harness.answerNext('computer_use_foreground', 'allow');
    assert.equal((await foreground).isError, false);

    harness.bypass = false;
    const managedBackground = harness.call({ delivery: 'background' });
    await harness.answerNext('capability', 'allow');
    assert.equal((await managedBackground).isError, false);
  });
});

type ForegroundScope = 'capability' | 'computer_use_foreground';
type RunIdentity = { sessionId: string; turnId: string; runId: string };

async function withForegroundAdmission(
  run: (harness: {
    policy: 'never' | 'ask' | 'allow';
    epoch: string;
    bypass: boolean;
    evidenceOverride: ClientCapabilityAdmissionEvidence | undefined;
    afterOutcomeCommitted: (() => Promise<void>) | undefined;
    readonly order: string[];
    readonly store: InteractiveInteractionStoreWriterFacade;
    connect(connectionId: string): Promise<void>;
    call(
      input?: Record<string, unknown>,
      identity?: Partial<RunIdentity>,
      signal?: AbortSignal,
    ): Promise<{ isError: boolean }>;
    pending(scope: ForegroundScope, sessionId?: string): ReturnType<typeof waitForPending>;
    answer(
      requestId: string,
      decision: 'allow' | 'deny',
      sessionId?: string,
    ): ReturnType<HostInteractionCoordinator['handlers']['interaction.answer']>;
    respondByText(
      requestId: string,
      text: string,
      sessionId?: string,
    ): ReturnType<HostInteractionCoordinator['handlers']['interaction.respondByText']>;
    answerNext(
      scope: ForegroundScope,
      decision: 'allow' | 'deny',
      sessionId?: string,
    ): Promise<void>;
    waitAccepted(count: number): Promise<void>;
    grantBackground(): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  await withStore(async ({ store }) => {
    const [nativeTool] = buildComputerUseTools({
      backend: {
        supportedActions: ['observe', 'click_element', 'double_click_element'],
        supportedForegroundActions: ['click_element', 'double_click_element'],
        preflight: async () => ({ accessibility: true, screenRecording: true }),
        run: async () => {
          throw new Error('Admission fixture must not execute native input');
        },
      },
    });
    assert.ok(nativeTool.parameters instanceof z.ZodType);
    const parameters = nativeTool.parameters;
    const schema = toJSONSchema(parameters, {
      io: 'input',
      target: 'draft-07',
      unrepresentable: 'any',
      cycles: 'ref',
      reused: 'inline',
    });
    delete schema.$schema;
    const inputSchema = projectToolInputSchema(schema);
    const interactions = createInteractionCoordinator(store, async () => {
      const pending = await store.listSessionPending(RUN.sessionId);
      if (pending.length === 0) await harness.afterOutcomeCommitted?.();
    });
    const runOwners = new Map<string, ReturnType<HostInteractionCoordinator['bindRun']>>();
    const snapshots = new Map<string, ClientCapabilitySnapshot>();
    const order: string[] = [];
    let acceptedCount = 0;
    const acceptanceWaiters: { count: number; resolve(): void }[] = [];
    const coordinator = new HostClientCapabilityCoordinator({
      isSessionRetired: async () => false,
      activation: new RuntimePolicyActivationGate(),
      onModelToolsChanged: () => undefined,
      interactions,
      grants: store,
    });
    let connection: ClientCapabilityConnection | undefined;
    let currentConnectionId = '';
    let callCount = 0;
    const harness = {
      policy: 'ask' as 'never' | 'ask' | 'allow',
      epoch: 'policy-epoch-1',
      bypass: false,
      evidenceOverride: undefined as ClientCapabilityAdmissionEvidence | undefined,
      afterOutcomeCommitted: undefined as (() => Promise<void>) | undefined,
      order,
      store,
      async connect(connectionId: string) {
        await connection?.close();
        for (const snapshot of snapshots.values()) snapshot.release();
        snapshots.clear();
        currentConnectionId = connectionId;
        const next = coordinator.attachConnection(
          { ...IDENTITY, connectionId },
          {
            send: async (sentFrame) => {
              const frame = decodeClientCapabilityHostFrame(JSON.parse(JSON.stringify(sentFrame)));
              if (frame.kind === 'client.capability.call') {
                const parsed = parameters.safeParse(frame.arguments);
                if (!parsed.success) {
                  next.accept(
                    decodeClientCapabilityClientFrame({
                      kind: 'client.capability.rejected',
                      invocationId: frame.invocationId,
                      message: parsed.error.message,
                    }),
                  );
                  return;
                }
                order.push('accepted');
                acceptedCount += 1;
                const args = parsed.data as { delivery?: 'background' | 'foreground' };
                next.accept(
                  decodeClientCapabilityClientFrame({
                    kind: 'client.capability.accepted',
                    invocationId: frame.invocationId,
                    admissionEvidence: harness.evidenceOverride ?? {
                      kind: 'computer_use',
                      delivery: args.delivery ?? 'background',
                      foregroundPolicy: harness.policy,
                      authorityEpoch: harness.epoch,
                    },
                  }),
                );
                for (const waiter of acceptanceWaiters)
                  if (acceptedCount >= waiter.count) waiter.resolve();
              } else if (frame.kind === 'client.capability.admitted') {
                order.push('admitted');
                next.accept({
                  kind: 'client.capability.result',
                  invocationId: frame.invocationId,
                  result: { content: [{ type: 'text', text: 'executed' }], summary: 'executed' },
                });
              }
            },
          },
        );
        connection = next;
        const result = await coordinator.handlers['client.capability.replace'](
          {
            registrationId: `registration-${connectionId}`,
            offers: [
              {
                offerId: 'desktop_computer_use',
                version: '1',
                affinity: 'session',
                hostPathAccess: 'none',
                label: 'Desktop Computer Use',
                tools: [
                  {
                    serverId: 'desktop_computer_use',
                    name: nativeTool.name,
                    inputSchema,
                  },
                ],
              },
            ],
          },
          connectionContext(connectionId),
        );
        assert.equal(result.ok, true, JSON.stringify(result));
      },
      async call(
        input: Record<string, unknown> = {},
        identity: Partial<RunIdentity> = {},
        signal = new AbortController().signal,
      ) {
        const current = { ...RUN, ...identity };
        const runKey = `${current.sessionId}/${current.turnId}/${current.runId}`;
        if (!runOwners.has(runKey)) runOwners.set(runKey, interactions.bindRun(current));
        let snapshot = snapshots.get(current.sessionId);
        if (!snapshot) {
          assert.deepEqual(await coordinator.bindSession(current.sessionId, currentConnectionId), {
            ok: true,
          });
          snapshot = coordinator.snapshotForSession(current.sessionId);
          assert.ok(snapshot);
          snapshots.set(current.sessionId, snapshot);
        }
        const tool = snapshot.tools[0];
        assert.ok(tool);
        const runtime = new ToolRuntime({
          ...current,
          header: { ...sessionHeader(), id: current.sessionId },
          connection: llmConnection(),
          modelId: 'model-1',
          readExecutionBoundary: async () =>
            harness.bypass
              ? createBypassExecutionBoundary(0)
              : createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
          readPermissionMode: async () => 'ask',
          newId: nextId(),
          now: nextNow(),
          getPermissionPauseTarget: () => null,
          invocationId: `invocation-${++callCount}`,
          runtimeCommitSink: {
            commitToolPrepared: async () => {
              order.push('T1');
              return { created: true, runtimeEventSeq: 1 };
            },
            commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
          },
        });
        const settled = await runtime.settleToolCall({
          tool,
          turnId: current.turnId,
          stepId: `step-${callCount}`,
          toolCallId: `call-${callCount}`,
          input: JSON.parse(
            JSON.stringify({
              action: 'click_element',
              delivery: 'foreground',
              observation_id: 'observation-1',
              element_id: 'button-1',
              ...input,
            }),
          ),
          abortSignal: signal,
          eventSink: { push: () => undefined, pushAndWaitUntilConsumed: async () => undefined },
        });
        return {
          isError:
            JSON.stringify(settled.result) !==
            JSON.stringify({ content: [{ type: 'text', text: 'executed' }], text: 'executed' }),
        };
      },
      async pending(scope: ForegroundScope, sessionId = RUN.sessionId) {
        const pending = await waitForPending(store, sessionId);
        assert.equal(pending.request.kind, 'client_capability');
        if (pending.request.kind === 'client_capability')
          assert.equal(pending.request.target.scope.kind, scope);
        return pending;
      },
      answer(requestId: string, decision: 'allow' | 'deny', sessionId = RUN.sessionId) {
        return interactions.handlers['interaction.answer'](
          { sessionId, interactionId: requestId, answer: { kind: 'client_capability', decision } },
          connectionContext('desktop-ui'),
        );
      },
      respondByText(requestId: string, text: string, sessionId = RUN.sessionId) {
        return interactions.handlers['interaction.respondByText'](
          { sessionId, interactionId: requestId, text },
          connectionContext('desktop-ui'),
        );
      },
      async answerNext(
        scope: ForegroundScope,
        decision: 'allow' | 'deny',
        sessionId = RUN.sessionId,
      ) {
        const pending = await harness.pending(scope, sessionId);
        assert.equal((await harness.answer(pending.requestId, decision, sessionId)).ok, true);
      },
      waitAccepted(count: number): Promise<void> {
        return acceptedCount >= count
          ? Promise.resolve()
          : new Promise((resolve) => acceptanceWaiters.push({ count, resolve }));
      },
      async grantBackground() {
        const call = harness.call({ delivery: undefined });
        await harness.answerNext('capability', 'allow');
        assert.equal((await call).isError, false);
      },
    };
    try {
      await harness.connect(IDENTITY.connectionId);
      await run(harness);
    } finally {
      for (const snapshot of snapshots.values()) snapshot.release();
      await connection?.close();
      await coordinator.close();
      for (const owner of runOwners.values()) {
        await owner.close('turn_terminal');
        owner.release();
      }
      await interactions.close();
    }
  });
}

async function verifyManagedAdmission(capability: (typeof CAPABILITIES)[number]): Promise<void> {
  await withStore(async ({ store }) => {
    const order: string[] = [];
    const toolCallByInvocation = new Map<string, string>();
    const cancelledToolCalls: string[] = [];
    let acceptedCount = 0;
    let resolveThirdAccepted!: () => void;
    const thirdAccepted = new Promise<void>((resolve) => {
      resolveThirdAccepted = resolve;
    });
    const interactions = createInteractionCoordinator(store);
    const runOwner = interactions.bindRun(RUN);
    const capabilities = new HostClientCapabilityCoordinator({
      isSessionRetired: async () => false,
      activation: new RuntimePolicyActivationGate(),
      onModelToolsChanged: () => undefined,
      interactions,
      grants: store,
    });
    let connection!: ClientCapabilityConnection;
    connection = capabilities.attachConnection(IDENTITY, {
      send: async (frame) => {
        if (frame.kind === 'client.capability.call') {
          toolCallByInvocation.set(frame.invocationId, frame.toolCallId);
          order.push('accepted');
          acceptedCount += 1;
          if (acceptedCount === 3) resolveThirdAccepted();
          connection.accept({
            kind: 'client.capability.accepted',
            invocationId: frame.invocationId,
            admissionEvidence: capability.evidence,
          });
        } else if (frame.kind === 'client.capability.cancel') {
          const toolCallId = toolCallByInvocation.get(frame.invocationId);
          if (toolCallId) cancelledToolCalls.push(toolCallId);
        } else if (frame.kind === 'client.capability.admitted') {
          order.push('admitted');
          connection.accept({
            kind: 'client.capability.result',
            invocationId: frame.invocationId,
            result: {
              content: [{ type: 'text', text: 'snapshot' }],
              ...(capability.serverId === 'desktop_computer_use' ? { summary: 'snapshot' } : {}),
            },
          });
        }
      },
    });
    let snapshot: ClientCapabilitySnapshot | undefined;
    try {
      const replaced = await capabilities.handlers['client.capability.replace'](
        {
          registrationId: 'desktop-native-registration',
          offers: [
            {
              offerId: capability.serverId,
              version: '1',
              affinity: 'session',
              hostPathAccess: 'none',
              label: capability.label,
              tools: [
                {
                  serverId: capability.serverId,
                  name: capability.toolName,
                  inputSchema: { type: 'object', additionalProperties: false },
                },
              ],
            },
          ],
        },
        connectionContext(IDENTITY.connectionId),
      );
      assert.equal(replaced.ok, true, JSON.stringify(replaced));
      assert.deepEqual(await capabilities.bindSession(RUN.sessionId, IDENTITY.connectionId), {
        ok: true,
      });
      snapshot = capabilities.snapshotForSession(RUN.sessionId);
      assert.ok(snapshot);
      const tool = snapshot.tools[0];
      assert.ok(tool);
      assert.equal(tool.hostAdmission, 'client_capability');
      assert.equal(tool.categoryHint, 'custom_tool');
      const runtime = new ToolRuntime({
        sessionId: RUN.sessionId,
        header: sessionHeader(),
        connection: llmConnection(),
        modelId: 'model-1',
        readExecutionBoundary: async () =>
          createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
        readPermissionMode: async () => 'ask',
        newId: nextId(),
        now: nextNow(),
        getPermissionPauseTarget: () => null,
        turnId: RUN.turnId,
        runId: RUN.runId,
        invocationId: 'invocation-1',
        runtimeCommitSink: {
          commitToolPrepared: async () => {
            order.push('T1');
            return { created: true, runtimeEventSeq: 1 };
          },
          commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
        },
      });
      const caller = new AbortController();
      const cancelled = runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-1',
        toolCallId: 'browser-call-1',
        input: capability.input,
        abortSignal: caller.signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      const request = await waitForPending(store);
      assert.equal(request.request.kind, 'client_capability');
      if (request.request.kind !== 'client_capability') return;

      const providerId = clientCapabilityProviderId(IDENTITY);
      assert.equal(request.request.target.providerId, providerId);
      assert.equal(request.request.target.capability, capability.target.capability);
      assert.deepEqual(request.request.target.scope, capability.target.scope);
      assert.equal(JSON.stringify(request).includes(IDENTITY.principalId), false);
      assert.equal(JSON.stringify(request).includes(IDENTITY.clientInstanceId), false);

      caller.abort(new DOMException('Code Mode deadline reached', 'TimeoutError'));
      await cancelled;
      const closed = await store.readInteraction(request.requestId);
      assert.equal(closed?.outcome?.outcome.kind, 'closure');
      if (closed?.outcome?.outcome.kind === 'closure') {
        assert.equal(closed.outcome.outcome.reason, 'timed_out');
      }
      assert.deepEqual(order, ['accepted']);

      const settling = runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-2',
        toolCallId: 'browser-call-2',
        input: capability.input,
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      const retryRequest = await waitForPending(store);
      assert.notEqual(retryRequest.requestId, request.requestId);
      assert.equal(retryRequest.request.kind, 'client_capability');
      if (retryRequest.request.kind !== 'client_capability') return;

      const joinedCaller = new AbortController();
      const joined = runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-3',
        toolCallId: 'browser-call-3',
        input: capability.input,
        abortSignal: joinedCaller.signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      await thirdAccepted;
      assert.deepEqual(
        (await store.listSessionPending(RUN.sessionId)).map((pending) => pending.requestId),
        [retryRequest.requestId],
      );

      joinedCaller.abort(new DOMException('Joined caller stopped', 'AbortError'));
      await joined;
      assert.deepEqual(cancelledToolCalls, ['browser-call-1', 'browser-call-3']);
      assert.deepEqual(order, ['accepted', 'accepted', 'accepted']);
      assert.equal((await store.readInteraction(retryRequest.requestId))?.outcome, undefined);

      const answered = await interactions.handlers['interaction.answer'](
        {
          sessionId: RUN.sessionId,
          interactionId: retryRequest.requestId,
          answer: { kind: 'client_capability', decision: 'allow' },
        },
        connectionContext('desktop-ui'),
      );
      assert.equal(answered.ok, true);
      order.push('approved');
      const settlement = await settling;
      const grant = await store.readClientCapabilitySessionGrant({
        sessionId: RUN.sessionId,
        ...retryRequest.request.target,
      });
      assert.equal(grant?.providerId, providerId);
      assert.deepEqual(settlement.result, {
        content: [{ type: 'text', text: 'snapshot' }],
        ...(capability.serverId === 'desktop_computer_use' ? { text: 'snapshot' } : {}),
      });
      assert.deepEqual(order, ['accepted', 'accepted', 'accepted', 'approved', 'T1', 'admitted']);

      const approvedAgain = await runtime.settleToolCall({
        tool,
        turnId: RUN.turnId,
        stepId: 'step-4',
        toolCallId: 'approved-call-4',
        input: capability.input,
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => undefined,
          pushAndWaitUntilConsumed: async () => undefined,
        },
      });
      assert.deepEqual(approvedAgain.result, {
        content: [{ type: 'text', text: 'snapshot' }],
        ...(capability.serverId === 'desktop_computer_use' ? { text: 'snapshot' } : {}),
      });
      assert.deepEqual(await store.listSessionPending(RUN.sessionId), []);
      assert.deepEqual(order.slice(-3), ['accepted', 'T1', 'admitted']);
    } finally {
      snapshot?.release();
      await connection.close();
      await capabilities.close();
      await runOwner.close('turn_terminal');
      runOwner.release();
      await interactions.close();
    }
  });
}

function sessionHeader(): SessionHeader {
  return {
    id: RUN.sessionId,
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    createdAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function llmConnection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `event-${++value}`;
}

function nextNow(): () => number {
  let value = 100;
  return () => ++value;
}

function connectionContext(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'host_epoch_1',
    connectionId,
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => undefined }),
  };
}

async function waitForPending(
  store: InteractiveInteractionStoreWriterFacade,
  sessionId = RUN.sessionId,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = await store.listSessionPending(sessionId);
    if (pending[0]) return pending[0];
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Client Capability approval was not published');
}

function createInteractionCoordinator(
  store: InteractiveInteractionStoreWriterFacade,
  afterContinuityRefresh: () => Promise<void> = async () => undefined,
): HostInteractionCoordinator {
  let now = 100;
  const options: HostInteractionCoordinatorOptions = {
    store,
    sandboxBoundaries: {
      createSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary publication');
      },
      readSandboxBoundaryRequest: async () => undefined,
      listPendingSandboxBoundaryRequests: async () => [],
      settleSandboxBoundaryRequest: async () => {
        throw new Error('Unexpected sandbox boundary settlement');
      },
      listHeaders: async () => [],
    },
    sessionAdmission: new SessionAdmissionGate(),
    sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
    now: () => ++now,
    preflightSessionSnapshot: () => true,
    refreshCanonicalContinuity: afterContinuityRefresh,
    onPoison: () => undefined,
    resolveSandboxBoundaryRootSession: async () => undefined,
    onSandboxBoundaryGraphWake: async () => undefined,
  };
  return new HostInteractionCoordinator(options);
}

interface StoreContext {
  readonly owner: InteractiveRootOwner;
  readonly store: InteractiveInteractionStoreWriterFacade;
  readonly stores: ExecutionStoresWriter<'interactive'>;
}

async function withStore(run: (context: StoreContext) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-client-capability-admission-'));
  const root = join(base, 'root');
  await mkdir(root);
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    await run({ owner, store: stores.interactionStore, stores });
  } finally {
    if (!owner.closed) await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}
