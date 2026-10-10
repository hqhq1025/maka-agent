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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent, ToolResultEvent } from '@maka/core/events';
import { createBypassExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { SessionHeader } from '@maka/core/session';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import type { CuDispatchOutcome, CuObservation } from '@maka/runtime/computer-use-types';
import { ToolRuntime } from '@maka/runtime/tool-runtime';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import {
  decodeClientCapabilityClientFrame,
  decodeClientCapabilityHostFrame,
} from '@maka/runtime-host/protocol';
import {
  ClientCapabilityChannel,
  HostClientCapabilityCoordinator,
  RuntimePolicyActivationGate,
  clientCapabilityCoordinatorTestAdmission,
} from '@maka/runtime-host/test-only/client-capability-host';
import { createDesktopNativeCapabilityProvider } from '../runtime-host-native-capabilities.js';
import {
  computerUseForegroundAuthorized,
  createComputerUseForegroundPolicyAuthority,
} from '../computer-use/foreground-admission.js';

const PRIVATE_LABEL = 'PRIVATE_AX_LABEL_9ce72b';
const NEXT_LABEL = 'LATER_CONTROL_LABEL';

for (const error of [undefined, 'dispatch_refused', 'outcome_unknown', 'reobserve_required', 'unsupported_action'] as const) {
  test(`native Computer result crosses the real proxy with truthful ${error ?? 'success'} status and a safe summary`, async () => {
    const foreground = error === 'reobserve_required';
    const noInput = foreground || error === 'unsupported_action';
    const outcome: CuDispatchOutcome = error && !foreground
      ? { ok: false, error, message: 'Fixture dispatch did not complete', messageIsAppTextFree: true,
          evidence: { effect: 'unverifiable', ...(noInput ? { path: 'none' as const } : {}) } }
      : { ok: true, tier: 'ax', verified: true };
    const observation: CuObservation = {
      observationId: 'native_observation', appId: 'Fixture', pid: 42, windowId: 7,
      appName: 'Native Fixture', windowTitle: 'Observed fixture window',
      contentFingerprint: 'fixture_structure',
      elements: [{ elementId: 'button', role: 'AXButton', label: PRIVATE_LABEL,
        identity: { token: 'fixture_token', role: 'AXButton', label: PRIVATE_LABEL } }],
    };
    let dispatches = 0;
    const nextObservation: CuObservation = { ...observation,
      elements: [{ ...observation.elements[0]!, label: NEXT_LABEL, value: 'PRIVATE_FIELD_VALUE' }] };
    const computerUseTools = buildComputerUseTools({ foregroundAuthorized: computerUseForegroundAuthorized, backend: {
      supportedForegroundActions: ['click_element'],
      preflight: async () => ({ accessibility: true, screenRecording: true }),
      observeApp: async () => dispatches ? nextObservation : observation,
      captureObservation: async () => nextObservation,
      runSemantic: async (_action, _signal, context) => {
        dispatches += 1;
        if (foreground) assert.equal(context.foregroundAuthorized, true);
        return { outcome, observation: nextObservation };
      },
      run: async () => ({ outcome }),
    } });
    const provider = createDesktopNativeCapabilityProvider({
      browserTools: [], resolveBrowserUrl: () => '', releaseBrowserSession() {},
      computerUseTools, releaseDesktopInteractionSession: computerUseTools.clearSession,
      ...(foreground ? { computerUseForegroundPolicy: createComputerUseForegroundPolicyAuthority(async () => 'ask') } : {}),
    }, { hostPathAccess: 'none', clientCwd: '/tmp' });
    const coordinator = new HostClientCapabilityCoordinator({
      ...clientCapabilityCoordinatorTestAdmission(),
      activation: new RuntimePolicyActivationGate(), onModelToolsChanged() {},
    });
    const context = { hostEpoch: 'host', connectionId: 'connection',
      principal: 'local_os_user' as const, acquireResidency: () => ({ release() {} }) };
    const wireResults: unknown[] = [];
    let channel!: ClientCapabilityChannel;
    const connection = coordinator.attachConnection({
      connectionId: 'connection', principalKind: 'local_owner',
      principalId: 'local', clientInstanceId: 'desktop',
    }, { send: async (frame) => channel.accept(decodeClientCapabilityHostFrame(JSON.parse(JSON.stringify(frame)))) });
    channel = new ClientCapabilityChannel({
      write: async (frame) => {
        const decoded = decodeClientCapabilityClientFrame(JSON.parse(JSON.stringify(frame)));
        if (decoded.kind === 'client.capability.result') wireResults.push(decoded.result);
        connection.accept(decoded);
      },
      replace: async (input) => {
        const result = await coordinator.handlers['client.capability.replace'](input, context);
        if (!result.ok) throw new Error(result.error.message);
        return result.result;
      },
      unregister: async (input) => {
        const result = await coordinator.handlers['client.capability.unregister'](input, context);
        if (!result.ok) throw new Error(result.error.message);
        return result.result;
      },
      onFailure: (failure) => { throw failure; },
    });
    const events: SessionEvent[] = [];
    const committed: unknown[] = [];
    const telemetry: unknown[] = [];
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-computer-activity-'));
    const databasePath = join(storageRoot, 'runtime.sqlite');
    let store = createSqliteRuntimeStore(databasePath);
    let snapshot: ReturnType<typeof coordinator.snapshotForSession>;
    try {
      await channel.replace(provider, 5_000);
      assert.deepEqual(await coordinator.bindSession('session', 'connection'), { ok: true });
      snapshot = coordinator.snapshotForSession('session');
      assert.ok(snapshot);
      const tool = snapshot.tools[0];
      assert.ok(tool);
      let seq = 0;
      const runtime = new ToolRuntime({
        sessionId: 'session', turnId: 'turn', runId: 'run', invocationId: 'invocation',
        header: header(), connection: { slug: 'fixture', providerType: 'openai', defaultModel: 'fixture' },
        modelId: 'fixture', readExecutionBoundary: async () => createBypassExecutionBoundary(0),
        readPermissionMode: async () => 'bypass', newId: () => `event_${++seq}`, now: () => seq,
        getPermissionPauseTarget: () => null,
        recordToolInvocation: (record) => { telemetry.push(record); },
        runtimeCommitSink: {
          commitToolPrepared: (input) => store.commitToolPrepared(input),
          commitToolOutcome: async (input) => { committed.push(input); return store.commitToolOutcome(input); },
        },
      });
      const call = (input: unknown, toolCallId: string) => runtime.settleToolCall({
        tool, turnId: 'turn', stepId: toolCallId, toolCallId, input,
        abortSignal: new AbortController().signal,
        eventSink: { push: (event) => { events.push(event); },
          pushAndWaitUntilConsumed: async (event) => { events.push(event); } },
      });
      const observedSettlement = await call({ action: 'observe', app: 'Invented model app alias' }, 'observe');
      assert.equal(observedSettlement.providerError, undefined);
      assert.ok(wireResults[0], 'native result must arrive through the capability channel');
      const observed = wireResults[0] as { content: Array<{ type: string; text?: string }> };
      const modelText = observed.content.find((part) => part.type === 'text')?.text ?? '';
      assert.ok(modelText.includes(PRIVATE_LABEL), 'the model still receives actionable AX labels');
      const observationId = /observation_id=(\S+)/.exec(modelText)?.[1];
      assert.ok(observationId);
      const settlement = await call({ action: 'click_element', observation_id: observationId,
        element_id: 'button', ...(foreground ? { delivery: 'foreground' } : {}) }, 'action');
      const result = settlement.result as { error?: string };
      const actionEvent = events.find((event): event is ToolResultEvent =>
        event.type === 'tool_result' && event.toolUseId === 'action');
      assert.ok(actionEvent);
      assert.equal(actionEvent.isError, Boolean(error));
      assert.equal(result.error, error);
      assert.equal(Boolean(settlement.providerError), Boolean(error));
      assert.equal(actionEvent.content.kind, 'text');
      if (actionEvent.content.kind !== 'text') throw new Error('Expected text result');
      const activity = actionEvent.content.computerUse;
      assert.ok(activity, 'the trusted result carries presentation metadata');
      assert.deepEqual(actionEvent.computerUse, activity, 'live and durable projections agree');
      assert.deepEqual(decodeCanonicalToolResultContent(JSON.parse(JSON.stringify(actionEvent.content))), actionEvent.content);
      assert.equal(activity.toolCallId, 'action');
      assert.equal(activity.action, 'click_element');
      assert.equal(activity.outcome.ok, !error);
      assert.equal(activity.outcome.error, error);
      assert.equal(activity.outcome.execution, noInput ? 'not_started' : 'attempted');
      if (foreground) {
        assert.equal(activity.outcome.reason, 'foreground_authorized_reobserve');
        assert.equal(activity.target, undefined);
      } else {
        assert.deepEqual(activity.target, {
          observationId, appId: 'Fixture', appName: 'Native Fixture',
          windowTitle: 'Observed fixture window', elementId: 'button', role: 'AXButton', label: PRIVATE_LABEL,
        }, 'the selected control belongs to the old observation, even after a fresh tree replaces the same element id');
        assert.equal(activity.outcome.effect, error ? 'unverifiable' : undefined);
        assert.equal(activity.outcome.verified, error ? undefined : true);
      }
      assert.ok(!JSON.stringify(actionEvent.modelProjection).includes('computerUse'), 'presentation metadata is not model output');
      assert.ok(!JSON.stringify(events.filter((event) => event.type === 'tool_start')).includes(PRIVATE_LABEL), 'host labels are not injected into model arguments');
      store.close();
      store = createSqliteRuntimeStore(databasePath);
      const reloaded = (await store.readImmutableRuntimeEvents('session', 'run'))
        .find((event) => event.content?.kind === 'function_response' && event.content.id === 'action');
      assert.ok(reloaded?.content?.kind === 'function_response');
      const reloadedContent = decodeCanonicalToolResultContent(reloaded.content.result);
      assert.ok(reloadedContent.kind === 'text');
      assert.deepEqual(reloadedContent.computerUse, activity, 'closing and reopening SQLite preserves the same authoritative target and outcome');
      if (foreground) {
        assert.equal(dispatches, 0, 'first foreground admission must not replay pre-approval input');
        const wire = wireResults.at(-1) as { summary?: string; error?: string };
        assert.equal(wire.error, 'reobserve_required');
        assert.match(wire.summary ?? '', /reobserve_required/);
        assert.match(settlement.providerError ?? '', /Call action:"observe"/);
        assert.doesNotMatch(settlement.providerError ?? '', /safe result summary/);
      }
      for (const event of events.filter((event): event is ToolResultEvent => event.type === 'tool_result')) {
        const summary = JSON.stringify(event.content, (key, value) => key === 'computerUse' ? undefined : value);
        assert.ok(!summary.includes(PRIVATE_LABEL), 'the text summary still excludes AX text');
        assert.ok(!JSON.stringify(event.content).includes('PRIVATE_FIELD_VALUE'), 'field values stay out of presentation metadata');
      }
      for (const row of committed) {
        const event = (row as { runtimeEvent: { content: Record<string, unknown> } }).runtimeEvent;
        const { modelProjection: _modelProjection, ...summary } = event.content;
        assert.ok(!JSON.stringify(summary, (key, value) => key === 'computerUse' ? undefined : value).includes(PRIVATE_LABEL), 'durable text summaries exclude AX text');
      }
      assert.ok(!JSON.stringify(telemetry).includes(PRIVATE_LABEL), 'telemetry excludes AX text');
      assert.equal((telemetry.at(-1) as { status: string }).status, error ? 'error' : 'success');
      assert.ok(JSON.stringify(events.find((event): event is ToolResultEvent => event.type === 'tool_result' && event.toolUseId === 'observe')?.modelProjection).includes(PRIVATE_LABEL), 'durable provider replay retains the model observation');
      if (foreground) {
        await call({ action: 'observe', app: 'Fixture' }, 'fresh-observe');
        const fresh = wireResults.at(-1) as { content: Array<{ type: string; text?: string }> };
        const freshId = /observation_id=(\S+)/.exec(fresh.content.find((part) => part.type === 'text')?.text ?? '')?.[1];
        assert.ok(freshId);
        assert.notEqual(freshId, observationId);
        const recovered = await call({ action: 'click_element', observation_id: freshId,
          element_id: 'button', delivery: 'foreground' }, 'fresh-action');
        assert.equal(recovered.providerError, undefined);
        assert.equal(dispatches, 1);
      }
    } finally {
      snapshot?.release();
      channel.close(new Error('Fixture cleanup'));
      await connection.close();
      await coordinator.close();
      await provider.close();
      store.close();
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
}

function header(): SessionHeader {
  return { id: 'session', workspaceRoot: '/tmp', cwd: '/tmp', createdAt: 0, name: 'fixture',
    titleIsManual: false, isFlagged: false, labels: [], isArchived: false, status: 'active',
    statusUpdatedAt: 0, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'fixture',
    connectionLocked: true, model: 'fixture', permissionMode: 'bypass', schemaVersion: 1 };
}
