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

// This manual acceptance lane requires real Electron preload/main, Host socket,
// persistent tool events, and native input. No E2E backend or injected UI grant.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createSettingsStore } from '@maka/storage/settings-store';
import { createProjectCatalog } from '@maka/storage/project-catalog';
import { createSessionStore } from '@maka/storage/session-store';
import { parseObservationText } from '@maka/runtime/test-only/observation-text-reader';
import { closeElectronApplication } from '../electron-lifecycle.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.MAKA_CUA_CONVERSATION_OUTPUT;
assert.ok(output, 'Set a fresh MAKA_CUA_CONVERSATION_OUTPUT evidence directory');
await mkdir(output, { recursive: true });
const replaySource = process.env.MAKA_CUA_CONVERSATION_REPLAY_REPORT;
const original = replaySource ? JSON.parse(await readFile(replaySource, 'utf8')) : undefined;
assert.notEqual(resolve(output, 'report.json'), replaySource && resolve(replaySource));
const userData = original?.userData ?? (await mkdtemp(join(tmpdir(), 'maka-cua-conversation-')));
const workspace = join(userData, 'workspaces', 'default');
const project = join(userData, 'controlled-project');
if (!original) await mkdir(project, { recursive: true });
const report = {
  status: 'running',
  mode: original ? 'replay' : 'native',
  ...(original
    ? {
        originalReport: replaySource,
        originalStatus: original.status,
        nativeEvidence: 'Not replayed; the original native result is unchanged.',
      }
    : {}),
  userData,
  platform: process.platform,
  checkpoints: [],
  provider: [],
  errors: [],
};
const checkpoint = (kind, data = {}) => {
  report.checkpoints.push({ kind, at: Date.now(), ...data });
  console.log(kind);
};
let app;
let appProcess;
let page;
let fixture;
let database;
let relay;
let sessionId;
let connectionId;
const lines = [];

function profile() {
  // The existing server credential stays in this process. Only a dummy local
  // relay key enters the throwaway Maka vault. No profile is modified.
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import json, os, subprocess, tomllib
v=tomllib.load(open(os.environ['MAKA_REAL_MODEL_CODEX_CONFIG'],'rb'))
p=v['model_providers'][os.environ.get('MAKA_REAL_MODEL_PROVIDER',v['model_provider'])]
a=p.get('auth',{})
secret=subprocess.run([a['command'],*a.get('args',[])],check=True,capture_output=True,text=True,timeout=15).stdout.strip() if a.get('command') else os.environ.get(p.get('env_key',''),'') or p.get('experimental_bearer_token','')
if not secret and not p['base_url'].startswith('http://127.0.0.1:'): raise RuntimeError('No active server credential')
print(json.dumps({'model':os.environ.get('MAKA_REAL_MODEL_ID',v['model']),'wire':p.get('wire_api'),'url':p['base_url'],'query':p.get('query_params',{}),'secret':secret}))
`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 },
    ),
  );
}

async function waitFor(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timed out: ${label}`);
}

async function readFixture(command, prefix) {
  const offset = lines.length;
  fixture.stdin.write(`${command}\n`);
  const line = await waitFor(
    () => lines.slice(offset).find((value) => value.startsWith(prefix)),
    command,
    5000,
  );
  return line.slice(prefix.length);
}

async function state() {
  return {
    count: Number(await readFixture('read', 'READ ')),
    text: await readFixture('text', 'TEXT '),
    gesture: JSON.parse(await readFixture('gesture', 'GESTURE ')),
  };
}

function records(table) {
  return database
    .prepare(`SELECT record_json FROM ${table}`)
    .all()
    .map((row) => JSON.parse(row.record_json));
}

function readDurableEvidence() {
  report.requests = records('core_interaction_requests');
  report.outcomes = records('core_interaction_outcomes');
  report.grants = records('core_client_capability_session_grants');
  report.events = database
    .prepare('SELECT payload_json FROM runtime_events ORDER BY event_seq')
    .all()
    .map((row) => JSON.parse(row.payload_json));
  report.runs = database
    .prepare(
      'SELECT session_id, run_id, created_at, latest_model_call_sequence FROM core_agent_runs ORDER BY created_at',
    )
    .all();
  report.modelCallAttempts = database
    .prepare('SELECT COUNT(*) AS count FROM usage_model_call_attempts')
    .get().count;
}

function validateDurableEvidence() {
  assert.equal(report.runs.length, 1, 'Expected one real AgentRun');
  assert.equal(report.requests.length, 2);
  assert.equal(report.outcomes.length, 2);
  assert.equal(report.grants.length, 2);
  const run = report.runs[0];
  for (const scope of ['capability', 'computer_use_foreground']) {
    const request = report.requests.find((entry) => entry.request.target?.scope.kind === scope);
    assert.ok(request, `Missing ${scope} request`);
    assert.equal(request.sessionId, run.session_id);
    assert.equal(request.runId, run.run_id);
    assert.equal(request.request.kind, 'client_capability');
    assert.equal(request.request.target.capability, 'computer_use');
    const outcome = report.outcomes.find((entry) => entry.requestId === request.requestId);
    assert.ok(outcome);
    for (const key of ['sessionId', 'runId', 'turnId']) assert.equal(outcome[key], request[key]);
    assert.equal(outcome.outcome.kind, 'client_capability_decision');
    assert.equal(outcome.outcome.decision, 'allow');
    if (scope === 'computer_use_foreground')
      assert.equal(outcome.outcome.responseText, '允许当前任务使用前台');
    const grant = report.grants.find((entry) => entry.scope.kind === scope);
    assert.deepEqual(grant, {
      version: 1,
      sessionId: request.sessionId,
      ...request.request.target,
      grantedAt: outcome.outcome.committedAt,
    });
  }
  const contents = report.events.map((entry) => entry.content).filter(Boolean);
  const calls = contents.filter((entry) => entry.kind === 'function_call');
  assert.ok(
    calls.every(
      (entry) =>
        entry.name === 'tool_search' || entry.name === 'mcp__desktop_computer_use__computer',
    ),
    'Unexpected tool outside the controlled Computer task',
  );
  const responses = contents.filter((entry) => entry.kind === 'function_response');
  assert.equal(
    responses.some((entry) => entry.isError && entry.result?.text?.includes('outcome_unknown')),
    false,
    'Unresolved native outcome',
  );
  const foreground = report.requests.find(
    (entry) => entry.request.target.scope.kind === 'computer_use_foreground',
  );
  const grantCall = calls.find((entry) => entry.id === foreground.request.toolUseId);
  assert.equal(grantCall?.args.action, 'double_click_element');
  assert.equal(grantCall.args.delivery, 'foreground');
  const refused = responses.find((entry) => entry.id === grantCall.id);
  assert.equal(refused?.isError, true);
  assert.match(refused.result.text, /reobserve_required/);
  const laterCalls = contents
    .slice(contents.indexOf(refused) + 1)
    .filter((entry) => entry.kind === 'function_call');
  assert.equal(
    laterCalls[0]?.args.action,
    'observe',
    'The first action after granting foreground must observe',
  );
  const observed = responses.find((entry) => entry.id === laterCalls[0].id);
  assert.ok(observed && !observed.isError);
  const projection = observed.modelProjection;
  const fresh = parseObservationText(
    projection.kind === 'text'
      ? projection.text
      : projection.parts
          .filter((part) => part.kind === 'text')
          .map((part) => part.text)
          .join('\n'),
  );
  assert.ok(fresh);
  const doubles = calls.filter((entry) => entry.args?.action === 'double_click_element');
  assert.equal(
    doubles.length,
    2,
    'Expected one admission-only attempt and one native double click',
  );
  const executed = doubles[1];
  assert.equal(executed.args.delivery, 'foreground');
  assert.notEqual(executed.args.observation_id, grantCall.args.observation_id);
  assert.equal(executed.args.observation_id, fresh.observation_id);
  assert.ok(fresh.elements.some((entry) => entry.element_id === executed.args.element_id));
  const executedResult = responses.find((entry) => entry.id === executed.id);
  assert.ok(executedResult && !executedResult.isError);
  assert.ok(
    report.events.some((entry) => entry.actions?.endInvocation && entry.status === 'completed'),
  );
}

async function openDesktop() {
  const env = { ...process.env, MAKA_SKIP_SHELL_ENV: '1' };
  for (const key of Object.keys(env))
    if (
      key.startsWith('MAKA_E2E') ||
      key === 'VITE_DEV_SERVER_URL' ||
      key === 'ELECTRON_RUN_AS_NODE' ||
      /_API_(KEY|TOKEN|SECRET)$/.test(key)
    )
      delete env[key];
  app = await electron.launch({
    args: [
      '.',
      `--user-data-dir=${userData}`,
      '--ozone-platform=x11',
      '--disable-gpu',
      '--no-sandbox',
    ],
    cwd: join(repository, 'apps/desktop'),
    env,
    timeout: 45000,
  });
  appProcess = app.process();
  appProcess.stderr.on('data', (value) => report.errors.push(value.toString()));
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.locator('.maka-composer-editor').waitFor({ timeout: 45000 });
  report.electron = await app.evaluate(({ app }) => ({
    versions: process.versions,
    userData: app.getPath('userData'),
  }));
  assert.equal(report.electron.userData, userData);
  const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByText('CUA 完整对话验收', { exact: true }).first().click();
  const desktopSession = (await page.evaluate(() => window.maka.sessions.list())).find(
    (entry) => entry.name === 'CUA 完整对话验收',
  );
  assert.ok(desktopSession);
  sessionId = desktopSession.id;
  report.desktopSessionId = sessionId;
  await page.screenshot({ path: join(output, 'initial.png') });
  checkpoint('real_desktop_ready');
}

async function verifyReloadedHistory() {
  await page.reload();
  await page.locator('.maka-composer-editor').waitFor();
  const processSummary = page.locator('.maka-processing-summary[aria-expanded="false"]').first();
  await processSummary.waitFor();
  await processSummary.click();
  await page
    .locator('.maka-computer-action, .maka-tool-activity-card')
    .first()
    .waitFor({ timeout: 30000 });
  const computerRows = page.locator('.maka-computer-action');
  report.reloadedComputerRows = [];
  for (const row of await computerRows.all()) {
    report.reloadedComputerRows.push({
      toolUseId: await row.getAttribute('data-tool-use-id'),
      state: await row.getAttribute('data-state'),
      heading: await row.locator(':scope > summary').innerText(),
    });
    assert.equal(await row.getAttribute('open'), null);
  }
  await page.screenshot({ path: join(output, 'restored-summary.png') });
  for (const row of await computerRows.all()) {
    await row.locator(':scope > summary').click();
    await row.locator('.maka-computer-action-log').waitFor({ state: 'visible' });
  }
  for (let opened = 0; opened < 24; opened += 1) {
    const collapsed = page
      .locator('.maka-tool-activity-card [role="button"][aria-expanded="false"]:visible')
      .first();
    if (!(await collapsed.count())) break;
    await collapsed.click();
  }
  report.reloadedToolText = await page.locator('.maka-tool-call-detail').allTextContents();
  report.reloadedText = await page.locator('body').innerText();
  report.pendingAfterReload = await page.evaluate(
    (id) => window.maka.sessions.listActiveInteractions(id),
    sessionId,
  );
  await page.screenshot({ path: join(output, 'reloaded.png') });
  assert.equal(report.pendingAfterReload.length, 0);
  assert.ok(
    report.reloadedToolText.some((text) => text.includes('reobserve_required')),
    'The restored tool history must show the admission-only refusal',
  );
  assert.ok(
    report.reloadedToolText.some(
      (text) =>
        text.includes('computer.double_click_element ok') && text.includes('delivery=foreground'),
    ),
    'The restored tool history must show the actual foreground result',
  );
  assert.deepEqual(records('core_interaction_outcomes'), report.outcomes);
  checkpoint('durable_results_after_reload');
}

async function send(text) {
  const editor = page.locator('.maka-composer-editor [contenteditable="true"]');
  await editor.fill(text);
  const submit = page.locator('.maka-composer button[type="submit"]');
  await submit.waitFor({ state: 'visible' });
  await waitFor(() => submit.isEnabled(), 'Composer send readiness', 15000);
  await submit.click();
}

try {
  assert.equal(process.platform, 'linux', 'This fixture owns an isolated Linux desktop');
  if (original) {
    database = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
    readDurableEvidence();
    validateDurableEvidence();
    const beforeReplay = {
      events: report.events,
      runs: report.runs,
      modelCallAttempts: report.modelCallAttempts,
    };
    await openDesktop();
    await verifyReloadedHistory();
    readDurableEvidence();
    assert.deepEqual(
      { events: report.events, runs: report.runs, modelCallAttempts: report.modelCallAttempts },
      beforeReplay,
      'Replay must not create a model call or change durable execution',
    );
    report.status = 'replay_passed';
  } else {
    const configured = profile();
    assert.equal(configured.wire, 'responses');
    report.model = configured.model;
    relay = createServer(async (request, response) => {
      try {
        if (request.headers.authorization !== 'Bearer local-cua-acceptance') {
          response.writeHead(401).end();
          return;
        }
        const body = Buffer.concat(await Array.fromAsync(request));
        const target = new URL(
          `${configured.url.replace(/\/$/, '')}/${request.url.replace(/^\/v1\//, '')}`,
        );
        for (const [key, value] of Object.entries(configured.query))
          target.searchParams.set(key, String(value));
        const record = { path: request.url, at: Date.now(), bytes: body.length };
        report.provider.push(record);
        assert.ok(report.provider.length <= 18, 'Bounded model request budget');
        const upstream = await fetch(target, {
          method: request.method,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${configured.secret}`,
          },
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body }),
          signal: AbortSignal.timeout(120000),
        });
        record.status = upstream.status;
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        for await (const chunk of upstream.body) response.write(chunk);
        response.end();
      } catch (error) {
        report.errors.push(String(error));
        response.writeHead(502).end('Acceptance relay failed');
      }
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const root = await resolveStorageRoot({ path: workspace, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(root);
    assert.ok(owner);
    try {
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const catalog = await stores.connectionCatalog.getSnapshot();
      const created = await stores.connectionCatalog.create({
        expectedCatalogRevision: catalog.revision,
        connection: {
          slug: 'cua-acceptance',
          name: 'CUA acceptance',
          providerType: 'openai',
          enabled: true,
          baseUrl: `http://127.0.0.1:${relay.address().port}/v1`,
          enabledModelIds: [configured.model],
        },
      });
      assert.equal(created.kind, 'committed');
      const connection = created.snapshot.connections.find(
        (value) => value.slug === 'cua-acceptance',
      );
      connectionId = connection.connectionId;
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: {
              scope: 'connection',
              connectionId: connection.connectionId,
              kind: 'api_key',
            },
            expected: null,
            secret: 'local-cua-acceptance',
          })
        ).kind,
        'committed',
      );
      const pending = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(pending.kind, 'ready');
      const inventory = await stores.operations.completeModelFetch(pending.ticket, {
        models: [{ id: configured.model, apiProtocol: 'openai-responses' }],
        source: 'fallback',
        fetchedAt: Date.now(),
      });
      assert.equal(inventory.kind, 'committed');
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: inventory.snapshot.revision,
            target: { connectionId: connection.connectionId, modelId: configured.model },
          })
        ).kind,
        'committed',
      );
    } finally {
      await owner.close();
    }
    await createSettingsStore(workspace).update({
      personalization: { uiLocale: 'zh-CN' },
      computerUse: { foregroundPolicy: 'ask' },
    });
    const projects = createProjectCatalog(workspace);
    const registered = await projects.register(project);
    projects.close();
    await writeFile(
      join(workspace, 'project-preferences.json'),
      JSON.stringify({ version: 1, selections: { [root.rootId]: registered.id } }),
    );
    const sessions = createSessionStore(workspace);
    const seeded = await sessions.create({
      cwd: project,
      llmConnectionId: connectionId,
      llmConnectionSlug: 'cua-acceptance',
      model: configured.model,
      permissionMode: 'ask',
      name: 'CUA 完整对话验收',
      labels: [],
    });
    sessionId = seeded.id;
    await sessions.close();
    report.sessionId = sessionId;
    fixture = spawn(
      '/usr/bin/python3',
      [join(repository, 'scripts/cua-driver-spike/real-model-smoke.linux-fixture.py')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    createInterface({ input: fixture.stdout }).on('line', (line) => lines.push(line));
    fixture.stderr.on('data', (value) => report.errors.push(value.toString()));
    await waitFor(() => lines.some((line) => line.startsWith('READY ')), 'native fixture', 15000);
    await openDesktop();
    database = new DatabaseSync(join(workspace, 'runtime.sqlite'), { readOnly: true });
    report.before = await state();
    if (process.env.MAKA_CUA_CONVERSATION_BOOT_ONLY === '1') {
      report.status = 'boot_passed';
    } else {
      await send(
        `只使用 computer 工具操作受控测试应用，PID ${fixture.pid}，窗口标题 Maka Cua Spike Counter。禁止操作其他应用、列出应用、使用 shell 或发送外部消息。先观察该 PID，使用观察到的 token 将 Message 填为“玛卡完整对话测试”，后台单击 Increment 一次。我明确要求使用 foreground 的 dedicated double_click_element 双击 Double-click target 一次，不要先后台双击。仍须通过 Host 申请授权，首次前台获准后重新观察并使用新 token。outcome_unknown 后只能观察，不能重试。最后如实报告。权限请求由用户通过 UI 回答。`,
      );
      for (const scope of ['ordinary', 'foreground']) {
        const interaction = await waitFor(async () => {
          const active = await page.evaluate(
            (id) => window.maka.sessions.listActiveInteractions(id),
            sessionId,
          );
          return active.find(
            (entry) =>
              entry.type === 'client_capability_request' && entry.capability === 'computer_use',
          );
        }, `${scope} interaction`);
        const before = await state();
        checkpoint(`${scope}_pending`, { interaction, state: before });
        assert.equal(before.gesture.doubleClicks, 0);
        if (scope === 'ordinary') assert.equal(before.count, 0);
        await page.screenshot({ path: join(output, `${scope}-pending.png`) });
        if (scope === 'ordinary')
          await page.getByRole('button', { name: '本任务允许', exact: true }).click();
        else await send('允许当前任务使用前台');
        await waitFor(
          async () =>
            !(
              await page.evaluate(
                (id) => window.maka.sessions.listActiveInteractions(id),
                sessionId,
              )
            ).some((entry) => entry.requestId === interaction.requestId),
          'exact interaction answered',
          15000,
        );
        checkpoint(`${scope}_answered`, { requestId: interaction.requestId });
      }
      await waitFor(
        async () => {
          const turns = await page.evaluate((id) => window.maka.sessions.listTurns(id), sessionId);
          report.turns = turns;
          return (
            turns.length &&
            turns.every((turn) => ['completed', 'failed', 'aborted'].includes(turn.status))
          );
        },
        'turn settled',
        90000,
      );
      readDurableEvidence();
      report.after = await state();
      report.fixtureOutput = [...lines];
      await writeFile(join(output, 'raw-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
      await page.screenshot({ path: join(output, 'completed.png') });
      validateDurableEvidence();
      assert.deepEqual(report.after, {
        count: 1,
        text: '玛卡完整对话测试',
        gesture: { doubleClicks: 1, physicalPresses: 2 },
      });
      await verifyReloadedHistory();
      report.status = 'passed';
    }
  }
} catch (error) {
  report.status = 'failed';
  report.failure = String(error.stack ?? error);
  if (database) {
    try {
      readDurableEvidence();
    } catch (evidenceError) {
      report.errors.push(`Durable evidence: ${evidenceError}`);
    }
  }
  if (fixture && fixture.exitCode === null && fixture.signalCode === null && !report.after) {
    try {
      report.after = await state();
    } catch (readbackError) {
      report.errors.push(`Native readback: ${readbackError}`);
    }
  }
  report.fixtureOutput = [...lines];
  if (page && !page.isClosed()) {
    report.lastUi = await page
      .locator('body')
      .innerText()
      .catch(() => 'unavailable');
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  database?.close();
  const exited = (child) => !child || child.exitCode !== null || child.signalCode !== null;
  if (app)
    await closeElectronApplication(app, 5000).catch((error) => report.errors.push(String(error)));
  if (fixture && !exited(fixture)) {
    if (fixture.stdin.writable) fixture.stdin.end('quit\n');
    try {
      await waitFor(() => exited(fixture), 'fixture graceful exit', 3000);
    } catch {
      fixture.kill('SIGKILL');
      await waitFor(() => exited(fixture), 'fixture forced exit', 2000).catch((error) =>
        report.errors.push(String(error)),
      );
    }
  }
  if (relay) {
    relay.closeAllConnections();
    await new Promise((done) => relay.close(done));
  }
  report.cleanup = {
    electronExited: exited(appProcess),
    fixtureExited: exited(fixture),
  };
  if (!report.cleanup.electronExited || !report.cleanup.fixtureExited) {
    report.status = 'failed';
    report.failure ??= 'Acceptance processes remain alive after cleanup';
    process.exitCode = 1;
  }
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      output,
      failure: report.failure,
      providerRequests: report.provider.length,
    }),
  );
}
