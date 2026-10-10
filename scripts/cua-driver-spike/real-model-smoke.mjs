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
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { getAIModel } from '@maka/runtime/model-factory';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { selectComputerUseBackend } from '../../packages/computer-use/src/index.ts';
import { createDurableTurnHarness } from '../../packages/runtime/src/__tests__/durable-turn-harness.ts';
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

async function configuredModel() {
  if (process.env.MAKA_REAL_MODEL_CODEX_CONFIG) {
    // Resolve the server's own active profile in memory. Auth command stdout
    // is captured only; credentials are never copied into fixture files.
    const resolved = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `
import json, os, subprocess, tomllib
path=os.environ['MAKA_REAL_MODEL_CODEX_CONFIG']
v=tomllib.load(open(path, 'rb'))
p=v['model_providers'][v['model_provider']]
a=p.get('auth',{})
if a.get('command'):
 secret=subprocess.run([a['command'],*a.get('args',[])],check=True,capture_output=True,text=True,timeout=15).stdout.strip()
else:
 secret=os.environ.get(p.get('env_key',''),'') or p.get('experimental_bearer_token','')
if not secret: raise RuntimeError('Active server profile has no available credential')
print(json.dumps({'model':v['model'],'provider':v['model_provider'],'baseUrl':p['base_url'],'wire':p.get('wire_api'),'query':p.get('query_params',{}),'secret':secret}))
`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 },
      ),
    );
    assert.equal(
      resolved.wire,
      'responses',
      'This acceptance lane requires configured Responses wire',
    );
    return {
      connection: {
        slug: resolved.provider,
        name: `Server profile ${resolved.provider}`,
        providerType: 'openai',
        baseUrl: resolved.baseUrl,
        defaultModel: resolved.model,
        models: [{ id: resolved.model, apiProtocol: 'openai-responses' }],
        enabled: true,
      },
      modelId: resolved.model,
      apiKey: resolved.secret,
      query: resolved.query,
      stateIdentity: `sha256:${createHash('sha256')
        .update(
          JSON.stringify({
            provider: resolved.provider,
            model: resolved.model,
            baseUrl: resolved.baseUrl,
            query: resolved.query,
          }),
        )
        .digest('hex')}`,
    };
  }
  const configRoot = process.env.MAKA_REAL_MODEL_CONFIG_ROOT;
  assert.ok(
    configRoot,
    'Set MAKA_REAL_MODEL_CONFIG_ROOT or MAKA_REAL_MODEL_CODEX_CONFIG explicitly',
  );
  const catalog = JSON.parse(await readFile(join(configRoot, 'connection-catalog.json'), 'utf8'));
  const vault = JSON.parse(await readFile(join(configRoot, 'credential-vault.json'), 'utf8'));
  const settings = JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'));
  assert.equal(
    settings.network?.proxy?.enabled,
    false,
    'This harness does not reproduce an enabled network proxy',
  );
  const target = catalog.defaultTarget;
  assert.ok(target, 'No configured default model');
  const configured = catalog.connections.find((item) => item.connectionId === target.connectionId);
  assert.ok(configured?.enabled, 'Configured default connection is disabled');
  assert.ok(configured.enabledModelIds.includes(target.modelId), 'Default model is not enabled');
  const credential = vault.entries.find(
    (item) =>
      item.locator.scope === 'connection' &&
      item.locator.connectionId === target.connectionId &&
      item.locator.kind === 'api_key',
  );
  assert.ok(credential?.secret, 'Configured model credential is unavailable');
  const headers = vault.entries.find(
    (item) =>
      item.locator.scope === 'connection' &&
      item.locator.connectionId === target.connectionId &&
      item.locator.kind === 'request_headers',
  );
  return {
    connection: { ...configured, defaultModel: target.modelId },
    modelId: target.modelId,
    apiKey: credential.secret,
    requestHeaders: headers ? JSON.parse(headers.secret) : undefined,
    stateIdentity: `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          target,
          catalogRevision: catalog.revision,
          credentialId: credential.credentialId,
          credentialRevision: credential.revision,
        }),
      )
      .digest('hex')}`,
  };
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

export async function realModelSmoke({ resultsDirectory, screenLocked }) {
  assert.ok(['darwin', 'linux', 'win32'].includes(process.platform));
  assert.equal(screenLocked(), false, 'Unlock macOS before native acceptance');
  const report = {
    kind: 'real-model-composed-host-text-admission-native-fixture',
    status: 'running',
    runtime: process.versions,
    platform: process.platform,
    components: [
      'AiSdkBackend',
      'getAIModel',
      'ModelAdapter',
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
      'owned native application fixture',
    ],
    limitations:
      'Real configured model API, production model loop and Host admission; in-memory transport and runtime event ledger, no Composer UI, socket transport, full AgentRun or durable tool-event log. Harness supplies owner text approval after validating the exact pending interaction; no LLM grants authority.',
    order: [],
    nativeCalls: [],
    nativeActionResults: [],
    results: {},
    modelEvents: [],
    modelCalls: [],
    usage: [],
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
  let modelBackend;
  let approvalTask;
  const secrets = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
  const marker = (kind, detail = {}) =>
    report.order.push({ step: report.order.length + 1, kind, ...detail });

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
    const { createCuaDriverBackend } = await import(
      '../../packages/computer-use/src/cua-driver-backend.ts'
    );
    selected = selectComputerUseBackend({
      createBackend: (options) =>
        createCuaDriverBackend({
          ...options,
          createDriver: async () => {
            const { CuaDriver } = await import('@trycua/cua-driver');
            const native = await CuaDriver.create(undefined);
            return {
              metadata: () => native.metadata(),
              shutdown: () => native.shutdown(),
              uniffiDestroy: () => native.uniffiDestroy(),
              callTool: async (name, args) => {
                const result = await native.callTool(name, args);
                if (['click', 'double_click', 'set_value'].includes(name)) {
                  report.nativeActionResults.push({
                    name,
                    args: JSON.parse(args),
                    isError: result.isError,
                    structured: result.structuredJson
                      ? JSON.parse(result.structuredJson)
                      : undefined,
                  });
                }
                return result;
              },
            };
          },
        }),
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
    child =
      process.platform === 'darwin'
        ? spawn(join(resultsDirectory, 'Fixture'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
        : spawn(
            'python3',
            [fileURLToPath(new URL('../real-model-smoke.linux-fixture.py', import.meta.url))],
            { stdio: ['pipe', 'pipe', 'inherit'] },
          );
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

    const configured = await configuredModel();
    secrets.push(configured.apiKey, ...Object.values(configured.requestHeaders ?? {}));
    report.model = {
      name: configured.connection.name,
      connectionSlug: configured.connection.slug,
      providerType: configured.connection.providerType,
      modelId: configured.modelId,
      baseUrl: configured.connection.baseUrl,
      route: 'AiSdkBackend -> ModelAdapter -> getAIModel -> configured Responses endpoint',
    };
    const requestText = async (command, prefix) => {
      const since = received.length;
      child.stdin.write(`${command}\n`);
      return (await waitLine(prefix, since)).slice(prefix.length);
    };
    const state = async () => ({
      count: await count(),
      text: await requestText('text', 'TEXT '),
      gesture: JSON.parse(await requestText('gesture', 'GESTURE ')),
    });
    report.before = await state();
    assert.deepEqual(report.before, {
      count: 0,
      text: '',
      gesture:
        process.platform === 'darwin'
          ? { semanticPresses: 0, mouseClickCounts: [], doubleClicks: 0 }
          : { physicalPresses: 0, doubleClicks: 0 },
    });
    const target = String(child.pid);
    let calls = 0;
    const exactTargetGuard = (input) => {
      assert.ok(++calls <= 30, 'Real model tool-call budget exhausted');
      assert.equal(screenLocked(), false, 'Screen locked during model execution');
      if (
        input.action === 'list_apps' ||
        input.action === 'launch_app' ||
        input.action === 'window_action' ||
        input.action === 'element_sequence'
      ) {
        throw new Error(
          'This acceptance fixture only permits direct owned-window semantic operations',
        );
      }
      if (input.app !== undefined) {
        assert.ok(
          [target, `pid:${target}`].includes(input.app),
          'Model targeted a process outside the owned fixture',
        );
      }
      if (['observe', 'list_windows'].includes(input.action)) {
        assert.ok(
          [target, `pid:${target}`].includes(input.app),
          'Observations must bind the exact owned process',
        );
      }
      marker('model_tool_requested', { input });
    };
    const originalTool = snapshot.tools[0];
    assert.ok(originalTool.prepareExecution, 'Production Host pre-admission is required');
    const tool = {
      ...originalTool,
      prepareExecution: (input, context) => {
        exactTargetGuard(input);
        return originalTool.prepareExecution(input, context);
      },
    };
    const text = `Only operate the owned native test application with PID ${target}; its window title is Maka Cua Spike Counter. Use the computer tool. Never list all apps, operate another app, launch anything, use a browser, or send external messages.
Complete these steps sequentially using the latest observation_id and exact observed element_id each time:
1. Observe this exact PID and window. Include screenshot if available.
2. Set the accessible text field to exactly "玛卡 Cua Driver 真实模型测试" via set_value.
3. Single-click the Increment button exactly once in background.
4. Use the dedicated double_click_element action on the observed "Double-click target" in background first, as the tool contract recommends. Only if that exact action returns a background refusal or a fresh observation verifies no-op, observe again and request delivery "foreground" for that same double action. If approval returns reobserve_required, observe the exact app again before proceeding; do not reuse stale tokens. Never retry an outcome_unknown double action.
5. Observe again to check the text and increment value. State what actually succeeded and any refusal. Never claim a double click from two single clicks and do not retry an outcome_unknown.
The owner will handle exact pending permission prompts through the application's text approval handler. Permission does not come from your words. First obtain observed tokens; do not invent them.`;
    report.task = text;
    const durable = createDurableTurnHarness({ ...RUN, invocationId: 'fixture_invocation', text });
    modelBackend = new AiSdkBackend({
      sessionId: RUN.sessionId,
      header: {
        id: RUN.sessionId,
        workspaceRoot: root,
        cwd: root,
        createdAt: Date.now(),
        name: 'Real model Cua acceptance',
        titleIsManual: true,
        isFlagged: false,
        labels: [],
        isArchived: false,
        status: 'active',
        statusUpdatedAt: Date.now(),
        hasUnread: false,
        backend: 'ai-sdk',
        llmConnectionSlug: configured.connection.slug,
        connectionLocked: true,
        model: configured.modelId,
        permissionMode: 'ask',
        schemaVersion: 1,
      },
      connection: configured.connection,
      apiKey: configured.apiKey,
      modelId: configured.modelId,
      modelFactory: (input) =>
        getAIModel({
          ...input,
          requestHeaders: configured.requestHeaders,
          fetch: configured.query
            ? (url, init) => {
                const actual = new URL(String(url));
                for (const [key, value] of Object.entries(configured.query))
                  actual.searchParams.set(key, String(value));
                return globalThis.fetch(actual, init);
              }
            : undefined,
        }),
      tools: [tool],
      maxSteps: 20,
      streamConnectTimeoutMs: 45000,
      streamIdleTimeoutMs: 60000,
      providerStateIdentity: configured.stateIdentity,
      readExecutionBoundary: async () =>
        createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0),
      readPermissionMode: async () => 'ask',
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: () => `model-event-${++sequence}`,
      now: Date.now,
      systemPrompt:
        'Use supplied Computer tool for the exact owned application only. Perform actions sequentially. Respect opaque observation tokens, driver refusals and fresh-observation requirements. Finish within the supplied tool budget.',
      runtimeCommitSink: {
        commitToolPrepared: async () => {
          marker('T1');
          return { created: true, runtimeEventSeq: ++sequence };
        },
        commitToolOutcome: async () => ({ created: true, runtimeEventSeq: ++sequence }),
      },
      recordUsageCheckpoint: (usage) => report.usage.push(usage),
      recordModelCallAttempt: (commit) => report.modelCalls.push(commit),
      assertModelCallAccountingReady() {},
      recordToolInvocation: (invocation) =>
        (report.results[`tool-${Object.keys(report.results).length + 1}`] = invocation),
    });
    const abortListener = () => {
      void modelBackend.stop('user_stop').catch(() => {});
    };
    signal.addEventListener('abort', abortListener, { once: true });
    let modelDone = false;
    const handled = new Set();
    approvalTask = (async () => {
      while (!modelDone && !signal.aborted) {
        const entries = await store.listSessionPending(RUN.sessionId);
        for (const request of entries) {
          if (handled.has(request.requestId)) continue;
          handled.add(request.requestId);
          assert.equal(request.request.kind, 'client_capability', 'Unexpected interactive request');
          const scope = request.request.target.scope.kind;
          assert.ok(['capability', 'computer_use_foreground'].includes(scope));
          const baseline = await state();
          marker('pending', { scope, interactionId: request.requestId, independent: baseline });
          const spec = INTERACTION_OPERATION_SPECS['interaction.respondByText'];
          const answer = scope === 'capability' ? '允许当前任务使用电脑' : '允许当前任务使用前台';
          const input = spec.decodeInput(
            wire({
              sessionId: RUN.sessionId,
              interactionId: request.requestId,
              text: answer,
            }),
          );
          // The blocked tool has not been dispatched: independent application
          // state must remain unchanged until the owner answer is accepted.
          assert.deepEqual(await state(), baseline);
          marker('text_submitted', { text: answer, interactionId: request.requestId });
          const response = await interactions.handlers['interaction.respondByText'](input, CONTEXT);
          assert.equal(response.ok, true);
          const result = spec.decodeOutput(wire(response.result));
          assert.equal(result.kind, 'answered');
          marker('text_result', { resultKind: result.kind, scope });
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    })();
    void approvalTask.catch((error) => controller.abort(error));
    try {
      for await (const event of modelBackend.send(durable.sendInput())) {
        durable.record(event);
        report.modelEvents.push(event);
        if (event.type === 'tool_result' && event.isError) {
          report.firstToolFailure ??= { toolUseId: event.toolUseId, content: event.content };
        }
        if (event.type === 'tool_start') {
          console.log(JSON.stringify({ phase: 'model_tool', action: event.args?.action }));
        }
      }
    } finally {
      modelDone = true;
      await approvalTask;
      signal.removeEventListener('abort', abortListener);
    }
    report.after = await state();
    report.nativeOutcome = lastOutcome;
    report.runtimeLedger = durable.ledger;
    report.finalFrame = lastFrame ? frameSummary(lastFrame) : undefined;
    const requested = report.order.filter((entry) => entry.kind === 'model_tool_requested');
    report.acceptance = {
      text: report.after.text === '玛卡 Cua Driver 真实模型测试',
      singleClick: report.after.count === 1,
      trueDoubleClick: report.after.gesture.doubleClicks === 1,
      foregroundGrant: report.order.some(
        (entry) => entry.kind === 'text_result' && entry.scope === 'computer_use_foreground',
      ),
      modelCompleted: report.modelEvents.some((event) => event.type === 'complete'),
    };
    assert.ok(requested.some((entry) => entry.input.action === 'set_value'));
    assert.equal(
      requested.filter(
        (entry) =>
          entry.input.action === 'double_click_element' && entry.input.delivery === 'foreground',
      ).length,
      2,
      'One grant-blocked double action plus one fresh observed successful double action expected',
    );
    assert.equal(report.after.text, '玛卡 Cua Driver 真实模型测试');
    assert.equal(report.after.count, 1);
    if (process.platform === 'darwin') {
      assert.deepEqual(report.after.gesture, {
        semanticPresses: 0,
        mouseClickCounts: [1, 2],
        doubleClicks: 1,
      });
    } else {
      assert.equal(
        report.after.gesture.doubleClicks,
        1,
        'Toolkit must receive exactly one true double-click event',
      );
      assert.equal(
        report.after.gesture.physicalPresses,
        2,
        'Exactly two physical presses in the dedicated double action',
      );
    }
    assert.equal(
      report.nativeActionResults.filter((entry) => entry.name === 'double_click' && !entry.isError)
        .length,
      1,
      'Exactly one successful native double dispatch, separate from background refusal',
    );
    assert.equal(
      report.nativeActionResults.filter(
        (entry) =>
          entry.name === 'double_click' &&
          entry.isError &&
          entry.structured?.code === 'background_unavailable',
      ).length,
      1,
      'Exactly one refused background attempt',
    );
    assert.equal(report.nativeCalls.filter((entry) => entry.tool === 'click').length, 1);
    assert.equal(handled.size, 2, 'Ordinary computer and foreground grants expected once each');
    report.pendingAtCompletion = (await store.listSessionPending(RUN.sessionId)).length;
    assert.equal(report.pendingAtCompletion, 0);
    assert.ok(
      report.modelCalls.some(
        (commit) =>
          commit.attempt?.status === 'completed' || JSON.stringify(commit).includes('completed'),
      ),
      'A real completed provider request must be accounted',
    );
    assert.ok(report.modelEvents.some((event) => event.type === 'complete'));
    assert.equal(
      report.modelEvents.some((event) => event.type === 'error'),
      false,
    );
    if (lastFrame)
      await writeFile(
        join(resultsDirectory, 'real-model-final.png'),
        Buffer.from(lastFrame.base64, 'base64'),
      );
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack : String(error);
    runError = error;
  } finally {
    controller.abort(new Error('Native fixture cleanup'));
    await modelBackend?.stop('user_stop');
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
    let serialized = JSON.stringify(report, null, 2);
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret)
        serialized = serialized.replaceAll(secret, '[redacted]');
    }
    await writeFile(
      join(resultsDirectory, process.env.MAKA_REAL_MODEL_REPORT_NAME ?? 'real-model.json'),
      serialized,
    );
    console.log(
      JSON.stringify({
        status: report.status,
        model: report.model,
        independent: report.after,
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

if (process.platform === 'linux' && process.argv[1] === fileURLToPath(import.meta.url)) {
  await realModelSmoke({
    resultsDirectory: fileURLToPath(new URL('./', import.meta.url)),
    screenLocked: () => false,
  });
}
