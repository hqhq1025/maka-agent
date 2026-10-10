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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { ToolRuntime } from '@maka/runtime/tool-runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { selectComputerUseBackend } from '../../packages/computer-use/src/index.ts';
import { parseObservationText } from '../../packages/runtime/src/__tests__/observation-text-reader.ts';
import { ClientCapabilityChannel } from '../../packages/runtime-host/src/client/client-capability-channel.ts';
import {
  decodeClientCapabilityClientFrame,
  decodeClientCapabilityHostFrame,
} from '../../packages/runtime-host/src/protocol/client-capability.ts';
import { INTERACTION_OPERATION_SPECS } from '../../packages/runtime-host/src/protocol/interaction.ts';
import { HostClientCapabilityCoordinator } from '../../packages/runtime-host/src/server/client-capability-coordinator.ts';
import { HostInteractionCoordinator } from '../../packages/runtime-host/src/server/interaction-coordinator.ts';
import { RuntimePolicyActivationGate } from '../../packages/runtime-host/src/server/runtime-policy-activation-gate.ts';
import { SessionAdmissionGate } from '../../packages/runtime-host/src/server/session-admission-gate.ts';
import { createDesktopNativeCapabilityProvider } from '../../apps/desktop/src/main/runtime-host-native-capabilities.ts';
import {
  computerUseForegroundAuthorized,
  createComputerUseForegroundPolicyAuthority,
} from '../../apps/desktop/src/main/computer-use/foreground-admission.ts';

const RUN = { sessionId: 'native_admission_fixture', turnId: 'fixture_turn', runId: 'fixture_run' };
const CONNECTION = 'fixture_desktop_connection';
const CONTEXT = {
  hostEpoch: 'fixture_host_epoch',
  connectionId: CONNECTION,
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

function resultText(result) {
  return (
    result.content
      ?.filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n') ?? ''
  );
}

function observation(result) {
  const text = resultText(result);
  const parsed = parseObservationText(text);
  assert.ok(parsed, text);
  const button = parsed.elements.find((element) => element.label === 'Increment');
  assert.ok(button, 'The exact fixture button needs a fresh semantic token');
  return { id: parsed.observation_id, button: button.element_id };
}

function frameSummary(frame) {
  assert.equal(frame?.mimeType, 'image/png', 'A native owned-window PNG is required');
  const bytes = Buffer.from(frame.base64, 'base64');
  assert.ok(bytes.length >= 24);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width >= 320 && width <= 800 && height >= 180 && height <= 600);
  return { width, height, bytes: bytes.length };
}

export async function hostAdmissionSmoke({ resultsDirectory, screenLocked }) {
  assert.equal(process.platform, 'darwin', 'Use the owned AppKit fixture on macOS');
  assert.equal(screenLocked(), false, 'Unlock macOS before native acceptance');
  const report = {
    kind: 'composed-host-text-admission-native-fixture',
    status: 'running',
    runtime: process.versions,
    components: [
      'ToolRuntime',
      'HostClientCapabilityCoordinator',
      'HostInteractionCoordinator',
      'SQLite InteractionStore',
      'ClientCapabilityChannel',
      'client-capability wire decoders',
      'DesktopNativeCapabilityProvider',
      'computerUseForegroundAuthorized',
      'selectComputerUseBackend',
      'Cua Driver 0.34.0',
      'owned AppKit fixture',
    ],
    limitations:
      'In-memory transport and tool-commit markers; no model call, composer UI, socket transport, or durable tool-event log.',
    order: [],
    nativeCalls: [],
    results: {},
  };
  const base = await mkdtemp(join(tmpdir(), 'maka-cua-host-admission-'));
  const root = join(base, 'root');
  await mkdir(root);
  let owner;
  let stores;
  let selected;
  let interactions;
  let capabilities;
  let channel;
  let connection;
  let provider;
  let snapshot;
  let runOwner;
  let child;
  let exited;
  let lines;
  let lastFrame;
  let lastOutcome;
  let runError;
  let sequence = 0;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]);
  const pendingCalls = new Set();
  const marker = (kind, detail = {}) =>
    report.order.push({ step: report.order.length + 1, kind, ...detail });
  const nativeMutations = () => report.nativeCalls.filter((call) => call.tool === 'click').length;

  try {
    owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(owner, 'The isolated fixture must own its temporary storage root');
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const store = stores.interactionStore;
    interactions = new HostInteractionCoordinator({
      store,
      sandboxBoundaries: {
        createSandboxBoundaryRequest: async () => {
          throw new Error('Unexpected sandbox request');
        },
        readSandboxBoundaryRequest: async () => undefined,
        listPendingSandboxBoundaryRequests: async () => [],
        settleSandboxBoundaryRequest: async () => {
          throw new Error('Unexpected sandbox settlement');
        },
        listHeaders: async () => [],
      },
      sessionAdmission: new SessionAdmissionGate(),
      sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
      now: Date.now,
      preflightSessionSnapshot: () => true,
      refreshCanonicalContinuity: async () => {},
      onPoison: (error) => {
        marker('interaction_poisoned', { error: String(error) });
      },
      resolveSandboxBoundaryRootSession: async () => undefined,
      onSandboxBoundaryGraphWake: async () => {},
    });
    runOwner = interactions.bindRun(RUN);
    capabilities = new HostClientCapabilityCoordinator({
      isSessionRetired: async () => false,
      activation: new RuntimePolicyActivationGate(),
      onModelToolsChanged() {},
      interactions,
      grants: store,
    });
    selected = selectComputerUseBackend({
      screenLocked,
      physicalInputRecentlyActive: () => false,
      foregroundAuthorized: computerUseForegroundAuthorized,
      onTrace: (event) => {
        report.nativeCalls.push(event);
        marker('native_result', event);
      },
      overlay: {
        onActionBegin() {},
        onObservation(value) {
          lastFrame = value.screenshot;
        },
        onActionEnd(_action, result) {
          lastOutcome = result?.outcome;
          lastFrame = result?.screenshot ?? result?.observation?.screenshot;
        },
      },
    });
    provider = createDesktopNativeCapabilityProvider(
      {
        browserTools: [],
        resolveBrowserUrl() {
          throw new Error('No browser in the owned fixture');
        },
        releaseBrowserSession() {},
        computerUseTools: selected.tools,
        computerUseForegroundPolicy: createComputerUseForegroundPolicyAuthority(async () => 'ask'),
        releaseDesktopInteractionSession(sessionId) {
          selected.tools.clearSession(sessionId);
          selected.backend?.clearSession?.(sessionId);
        },
      },
      { hostPathAccess: 'none', clientCwd: root, isTargetValid: () => !signal.aborted },
    );
    connection = capabilities.attachConnection(
      {
        connectionId: CONNECTION,
        principalKind: 'capability_provider',
        principalId: 'desktop:native-fixture',
        clientInstanceId: 'native-fixture-client',
      },
      {
        send: async (value) => {
          const frame = decodeClientCapabilityHostFrame(wire(value));
          marker(frame.kind, { invocationId: frame.invocationId });
          channel.accept(frame);
        },
      },
    );
    const requireResult = (response) => {
      assert.equal(response.ok, true, JSON.stringify(response));
      return response.result;
    };
    channel = new ClientCapabilityChannel({
      write: async (value) => {
        const frame = decodeClientCapabilityClientFrame(wire(value));
        marker(frame.kind, { invocationId: frame.invocationId });
        connection.accept(frame);
      },
      replace: async (input) =>
        requireResult(await capabilities.handlers['client.capability.replace'](input, CONTEXT)),
      unregister: async (input) =>
        requireResult(await capabilities.handlers['client.capability.unregister'](input, CONTEXT)),
      onFailure: (error) => {
        marker('channel_failure', { error: String(error) });
        controller.abort(error);
      },
    });
    await channel.replace(provider, 10000);
    assert.deepEqual(await capabilities.bindSession(RUN.sessionId, CONNECTION), { ok: true });
    snapshot = capabilities.snapshotForSession(RUN.sessionId);
    assert.ok(snapshot?.tools[0]);

    assert.equal(screenLocked(), false, 'The session locked before fixture launch');
    child = spawn(join(resultsDirectory, 'Fixture'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
    exited = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error: String(error) }));
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    child.stdin.on('error', () => {});
    lines = createInterface({ input: child.stdout });
    const received = [];
    lines.on('line', (line) => received.push(line));
    const waitLine = async (prefix, since = 0) => {
      const find = () => received.slice(since).find((line) => line.startsWith(prefix));
      while (!find()) {
        await Promise.race([
          once(lines, 'line', { signal }),
          exited.then((exit) => {
            throw new Error(`Fixture exited: ${JSON.stringify(exit)}`);
          }),
        ]);
      }
      return find();
    };
    await waitLine(`READY ${child.pid}`);
    const count = async () => {
      const since = received.length;
      child.stdin.write('read\n');
      const value = Number((await waitLine('READ ', since)).slice(5));
      assert.ok(Number.isInteger(value));
      return value;
    };
    const assertNoInput = async (phase) => {
      const fixtureCount = await count();
      const nativeClicks = nativeMutations();
      marker('no_input', { phase, fixtureCount, nativeClicks });
      assert.equal(fixtureCount, 0);
      assert.equal(nativeClicks, 0);
    };

    const call = (input) => {
      const id = ++sequence;
      const runtime = new ToolRuntime({
        ...RUN,
        header: {
          id: RUN.sessionId,
          workspaceRoot: root,
          cwd: root,
          createdAt: 1,
          name: 'Native admission fixture',
          titleIsManual: false,
          isFlagged: false,
          labels: [],
          isArchived: false,
          status: 'active',
          statusUpdatedAt: 1,
          hasUnread: false,
          backend: 'ai-sdk',
          llmConnectionSlug: 'fixture-connection',
          connectionLocked: true,
          model: 'fixture-model',
          permissionMode: 'ask',
          schemaVersion: 1,
        },
        connection: {
          slug: 'fixture-connection',
          name: 'No network fixture',
          providerType: 'openai',
          defaultModel: 'fixture-model',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        modelId: 'fixture-model',
        readExecutionBoundary: async () =>
          createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
        readPermissionMode: async () => 'ask',
        newId: () => `event-${++sequence}`,
        now: Date.now,
        getPermissionPauseTarget: () => null,
        invocationId: `invocation-${id}`,
        runtimeCommitSink: {
          commitToolPrepared: async () => {
            marker('T1', { callId: id });
            return { created: true, runtimeEventSeq: ++sequence };
          },
          commitToolOutcome: async () => ({ created: true, runtimeEventSeq: ++sequence }),
        },
      });
      const task = runtime
        .settleToolCall({
          tool: snapshot.tools[0],
          turnId: RUN.turnId,
          stepId: `step-${id}`,
          toolCallId: `call-${id}`,
          input: wire(input),
          abortSignal: signal,
          eventSink: { push() {}, pushAndWaitUntilConsumed: async () => {} },
        })
        .then((settled) => settled.result);
      pendingCalls.add(task);
      void task.finally(() => pendingCalls.delete(task)).catch(() => {});
      return task;
    };
    const pending = async (scope) => {
      let entries = [];
      while (entries.length === 0) {
        signal.throwIfAborted();
        entries = await store.listSessionPending(RUN.sessionId);
        if (entries.length === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(entries.length, 1);
      const request = entries[0];
      assert.equal(request.request.kind, 'client_capability');
      assert.equal(request.request.target.scope.kind, scope);
      marker('pending', { scope, interactionId: request.requestId });
      return request;
    };
    const answerText = async (request, text) => {
      const spec = INTERACTION_OPERATION_SPECS['interaction.respondByText'];
      const input = spec.decodeInput(
        wire({ sessionId: RUN.sessionId, interactionId: request.requestId, text }),
      );
      marker('text_submitted', { text, interactionId: request.requestId });
      const response = await interactions.handlers['interaction.respondByText'](input, CONTEXT);
      const result = spec.decodeOutput(wire(requireResult(response)));
      spec.assertOutputForInput?.(input, result);
      marker('text_result', { resultKind: result.kind });
      return result;
    };
    const observeInput = { action: 'observe', app: String(child.pid), include_screenshot: true };
    const initial = call(observeInput);
    const computerRequest = await pending('capability');
    assert.equal(
      report.nativeCalls.length,
      0,
      'No native operation before ordinary Computer Use admission',
    );
    assert.equal(
      report.order.some((event) => event.kind === 'T1'),
      false,
    );
    await assertNoInput('ordinary_permission_pending');
    assert.equal((await answerText(computerRequest, '允许当前任务使用电脑')).kind, 'answered');
    report.results.initialObserve = await initial;
    const first = observation(report.results.initialObserve);
    report.initialFrame = frameSummary(lastFrame);

    const foreground = call({
      action: 'click_element',
      delivery: 'foreground',
      observation_id: first.id,
      element_id: first.button,
    });
    const foregroundRequest = await pending('computer_use_foreground');
    await assertNoInput('foreground_permission_pending');
    assert.equal(
      await store.readClientCapabilitySessionGrant({
        sessionId: RUN.sessionId,
        ...foregroundRequest.request.target,
      }),
      undefined,
    );
    assert.equal(
      (await answerText(foregroundRequest, '你说的批准是什么意思？')).kind,
      'unrecognized',
    );
    assert.equal((await store.listSessionPending(RUN.sessionId)).length, 1);
    await assertNoInput('unrecognized_text');
    assert.equal((await answerText(foregroundRequest, '允许当前任务使用前台')).kind, 'answered');
    const grant = await store.readClientCapabilitySessionGrant({
      sessionId: RUN.sessionId,
      ...foregroundRequest.request.target,
    });
    assert.ok(grant);
    marker('stored_foreground_grant', { scope: grant.scope.kind });
    report.results.firstForegroundAdmission = await foreground;
    assert.match(resultText(report.results.firstForegroundAdmission), /reobserve_required/);
    await assertNoInput('authorized_but_reobserve_required');

    report.results.freshObserve = await call(observeInput);
    const fresh = observation(report.results.freshObserve);
    assert.notEqual(fresh.id, first.id);
    assert.equal(screenLocked(), false, 'The session locked before foreground input');
    report.results.foregroundClick = await call({
      action: 'click_element',
      delivery: 'foreground',
      observation_id: fresh.id,
      element_id: fresh.button,
    });
    report.independentCount = await count();
    report.nativeOutcome = lastOutcome;
    report.finalFrame = frameSummary(lastFrame);
    assert.equal(lastOutcome?.ok, true, 'The executor must return a successful native outcome');
    assert.notEqual(
      observation(report.results.foregroundClick).id,
      fresh.id,
      'The native action must produce a fresh observation',
    );
    assert.equal(nativeMutations(), 1, 'Exactly one native click should be dispatched');
    assert.equal(
      report.independentCount,
      1,
      'The owned application must confirm exactly one effect',
    );
    assert.equal(lastOutcome?.evidence?.requestedDelivery, 'foreground');
    assert.equal(lastOutcome?.evidence?.actualDelivery, 'foreground');
    assert.equal(
      (await store.listSessionPending(RUN.sessionId)).length,
      0,
      'The task grant must be reused',
    );
    await writeFile(
      join(resultsDirectory, 'host-admission-final.png'),
      Buffer.from(lastFrame.base64, 'base64'),
    );
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack : String(error);
    runError = error;
  } finally {
    controller.abort(new Error('Native fixture cleanup'));
    await Promise.allSettled([...pendingCalls]);
    const cleanupErrors = [];
    for (const [stage, close] of [
      ['capability_snapshot', () => snapshot?.release()],
      ['channel', () => channel?.close(new Error('Native fixture cleanup'))],
      ['connection', () => connection?.close()],
      ['capability_coordinator', () => capabilities?.close()],
      ['run_close', () => runOwner?.close('turn_terminal')],
      ['run_release', () => runOwner?.release()],
      ['interactions', () => interactions?.close()],
      ['provider', () => provider?.close()],
      ['backend', () => selected?.backend?.dispose?.()],
      [
        'fixture',
        async () => {
          if (!child) return;
          child.stdin.end('quit\n');
          report.fixtureExit = await exited;
          assert.equal(report.fixtureExit.code, 0, 'Fixture must exit successfully');
        },
      ],
      ['fixture_lines', () => lines?.close()],
      ['execution_stores', () => stores?.sessionStore.close()],
      [
        'root_owner',
        async () => {
          if (owner && !owner.closed) await owner.close();
        },
      ],
      [
        'root_control_directory',
        async () => {
          if (owner) await rm(owner.controlDirectory, { recursive: true, force: true });
        },
      ],
      ['temporary_root', () => rm(base, { recursive: true, force: true })],
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupErrors.push({ stage, error: error instanceof Error ? error.stack : String(error) });
      }
    }
    if (cleanupErrors.length) {
      report.status = 'failed';
      report.cleanupErrors = cleanupErrors;
    }
    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(join(resultsDirectory, 'host-admission.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        status: report.status,
        count: report.independentCount,
        outcome: report.nativeOutcome,
        frame: report.finalFrame,
        fixtureExit: report.fixtureExit,
        error: report.error,
        cleanupErrors: report.cleanupErrors,
      }),
    );
    if (cleanupErrors.length) {
      throw new AggregateError(
        [
          ...(runError ? [runError] : []),
          ...cleanupErrors.map((entry) => new Error(`${entry.stage}: ${entry.error}`)),
        ],
        'Native acceptance cleanup failed',
      );
    }
  }
  if (runError) throw runError;
}
