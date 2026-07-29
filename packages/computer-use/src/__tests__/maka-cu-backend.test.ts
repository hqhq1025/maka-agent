// Unit test for the maka-cu CuDispatchBackend. Drives the module against a MOCK
// executor (a small CommonJS node script written to a temp dir) that speaks
// `maka.cu/1` — the real `maka-cu` binary is never spawned, and does not exist
// as a signed artifact yet. The mock records every message it receives to an
// NDJSON log the test inspects, the same way the cua-driver backend test does.
//
// Run (from repo root), after @maka/core + @maka/runtime are built:
//   npm --workspace @maka/computer-use run test
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { CuaBoundAction, CuObservation, CuRunContext } from '@maka/runtime';
import { createMakaCuBackend, type MakaCuBackendOptions } from '../maka-cu-backend.js';
import { selectComputerUseBackend } from '../select-backend.js';

const RUN_CONTEXT: CuRunContext = {
  sessionId: 'test-session',
  turnId: 'test-turn',
  toolCallId: 'call-1',
};

// A CommonJS mock maka-cu executor. No backticks / ${} inside → embedded via
// String.raw so escapes survive into the written file.
const MOCK_SRC = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LOG = process.env.MAKACU_MOCK_LOG || '';
const PROTOCOL = process.env.MAKACU_MOCK_PROTOCOL || 'maka.cu/1';
const DISPATCH_ERROR = process.env.MAKACU_MOCK_DISPATCH_ERROR || '';
const TIER = process.env.MAKACU_MOCK_TIER || 'ax';
const PATH_NAME = process.env.MAKACU_MOCK_PATH || 'ax_action';
const BAD_IMAGE_SHA = process.env.MAKACU_MOCK_BAD_IMAGE_SHA === '1';
const NO_POST_SNAPSHOT = process.env.MAKACU_MOCK_NO_POST_SNAPSHOT === '1';
const NONCE = crypto.randomBytes(16).toString('hex');
// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
let imageDir = '';
let snapshotSeq = 0;
function logRec(rec) {
  if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch (e) {} }
}
logRec({ kind: 'start', pid: process.pid, argv: process.argv.slice(2) });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function ok(id, fields) { send({ jsonrpc: '2.0', id: id, result: Object.assign({ ok: true }, fields) }); }
function domainError(id, code, detail) {
  send({ jsonrpc: '2.0', id: id, result: { ok: false, error: {
    code: code, message: 'mock refused: ' + code, detail: detail || {} } } });
}
function writeImage(name) {
  const file = path.join(imageDir, name + '.png');
  fs.writeFileSync(file, PNG);
  const sha = crypto.createHash('sha256').update(PNG).digest('hex');
  return {
    path: file,
    format: 'png',
    widthPx: 1200,
    heightPx: 800,
    byteLength: PNG.byteLength,
    sha256: BAD_IMAGE_SHA ? sha.split('').reverse().join('') : sha,
    scale: 2,
  };
}
function element(index, label, focused) {
  return {
    token: 'el_' + index,
    parentToken: index === 1 ? null : 'el_1',
    depth: index === 1 ? 0 : 1,
    role: index === 1 ? 'AXWindow' : 'AXButton',
    subrole: null,
    axIdentifier: 'id_' + index,
    label: label,
    value: null,
    placeholder: null,
    enabled: true,
    focused: !!focused,
    selected: null,
    frame: { x: 10 * index, y: 20 * index, width: 72, height: 28 },
    actions: ['press'],
    digest: 'sha256:digest_' + index,
    truncated: [],
  };
}
function snapshot(includeImage) {
  snapshotSeq += 1;
  const id = 'snap_' + NONCE + '_' + snapshotSeq;
  return {
    snapshotId: id,
    capturedAt: Date.now(),
    target: {
      pid: 4711,
      windowId: 90210,
      bundleId: 'com.example.Fixture',
      appName: 'Fixture',
      title: 'Untitled',
      bounds: { x: 0, y: 25, width: 600, height: 400 },
      layer: 0,
      zIndex: 3,
      displayId: '69732928',
    },
    windowDigest: 'sha256:window_' + snapshotSeq,
    focusedElementToken: 'el_2',
    selectedText: null,
    image: includeImage ? writeImage(id) : null,
    displays: [{
      displayId: '69732928',
      logicalBounds: { x: 0, y: 0, width: 1512, height: 982 },
      sourceBoundsPx: { x: 0, y: 0, width: 3024, height: 1964 },
      scaleFactor: 2,
    }],
    obscuringRects: [],
    elements: [element(1, 'Fixture Window', false), element(2, 'Send', true)],
    truncated: { elements: false, depth: false },
  };
}
function dispatchReply(id, params) {
  if (DISPATCH_ERROR) { domainError(id, DISPATCH_ERROR, { wouldRequirePath: 'cg_event_global' }); return; }
  ok(id, {
    toolCallId: params.toolCallId,
    outcome: 'ok',
    tier: TIER,
    path: PATH_NAME,
    effect: 'confirmed',
    verification: { method: 'tree_delta', observedChange: true },
    settle: { waitedMs: 12, quiesced: true, reason: 'quiesced' },
    snapshot: NO_POST_SNAPSHOT ? null : snapshot(true),
  });
}
function handle(msg) {
  const id = msg.id;
  const params = msg.params || {};
  switch (msg.method) {
    case 'host.hello':
      if (params.protocol !== PROTOCOL) {
        send({ jsonrpc: '2.0', id: id, error: { code: -32000,
          message: 'protocol_version_mismatch', data: { supported: [PROTOCOL] } } });
        setTimeout(function () { process.exit(78); }, 5);
        return;
      }
      imageDir = params.imageDir;
      ok(id, {
        protocol: PROTOCOL,
        executor: { name: 'maka-cu-mock', version: '0.0.1', commit: 'testing' },
        pid: process.pid,
        capabilities: {
          captureStream: false,
          elementActions: ['click', 'set_value', 'select_text', 'secondary_action', 'scroll'],
          pointActions: ['move', 'left_click', 'right_click', 'middle_click', 'double_click',
            'triple_click', 'mouse_down', 'mouse_up', 'drag', 'scroll'],
          keyActions: ['type', 'key'],
          imageFormats: ['png', 'jpeg'],
        },
        limits: {
          snapshotsPerSession: 8,
          snapshotTtlMs: 120000,
          maxElements: 1500,
          maxDepth: 64,
          maxTextChars: 500,
          maxResponseBytes: 1048576,
          settleCeilingMs: 2500,
          shutdownGraceMs: 3000,
          imageDirBudgetBytes: 268435456,
        },
      });
      return;
    case 'session.begin':
      ok(id, {});
      return;
    case 'session.end':
      ok(id, { released: { snapshots: 1, images: 1, streams: 0 } });
      return;
    case 'permissions.check':
      ok(id, { accessibility: true, screenRecording: true, screenRecordingProbe: 'capture_succeeded' });
      return;
    case 'apps.list':
      ok(id, { apps: [{ appId: 'com.example.Fixture', pid: 4711, name: 'Fixture',
        bundleId: 'com.example.Fixture', windowCount: 1, running: true }] });
      return;
    case 'window.list':
      ok(id, { windows: [{ pid: 4711, windowId: 90210, appName: 'Fixture', title: 'Untitled',
        bounds: { x: 0, y: 25, width: 600, height: 400 }, layer: 0, zIndex: 3,
        onScreen: true, displayId: '69732928' }] });
      return;
    case 'observe':
      ok(id, { snapshot: snapshot(params.includeImage !== false) });
      return;
    case 'screen.capture':
      ok(id, { image: writeImage('cap_' + Date.now()), displayId: '69732928', capturedAt: Date.now() });
      return;
    case 'dispatch.element':
    case 'dispatch.key':
    case 'dispatch.point':
      dispatchReply(id, params);
      return;
    default:
      send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'unknown_method' } });
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    logRec({ kind: 'recv', method: msg.method, id: msg.id, params: msg.params });
    if (typeof msg.id !== 'number') continue;
    handle(msg);
  }
});
`;

let workDir = '';
let mockPath = '';
const disposers: Array<() => void> = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRecords(logPath: string): Promise<Array<Record<string, any>>> {
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function received(records: Array<Record<string, any>>, method: string): Record<string, any>[] {
  return records.filter((r) => r.kind === 'recv' && r.method === method).map((r) => r.params ?? {});
}

function makeBackend(
  opts: {
    protocol?: string;
    dispatchError?: string;
    tier?: string;
    path?: string;
    badImageSha?: boolean;
    noPostSnapshot?: boolean;
    physicalInputRecentlyActive?: MakaCuBackendOptions['physicalInputRecentlyActive'];
    allowCompatibilityInputDispatch?: boolean;
    onTrace?: MakaCuBackendOptions['onTrace'];
  } = {},
): { backend: ReturnType<typeof createMakaCuBackend>; logPath: string; imageDir: string } {
  const logPath = join(workDir, 'log-' + randomUUID() + '.ndjson');
  const imageDir = join(workDir, 'images-' + randomUUID());
  process.env.MAKACU_MOCK_LOG = logPath;
  process.env.MAKACU_MOCK_PROTOCOL = opts.protocol ?? 'maka.cu/1';
  process.env.MAKACU_MOCK_DISPATCH_ERROR = opts.dispatchError ?? '';
  process.env.MAKACU_MOCK_TIER = opts.tier ?? 'ax';
  process.env.MAKACU_MOCK_PATH = opts.path ?? 'ax_action';
  process.env.MAKACU_MOCK_BAD_IMAGE_SHA = opts.badImageSha ? '1' : '';
  process.env.MAKACU_MOCK_NO_POST_SNAPSHOT = opts.noPostSnapshot ? '1' : '';
  const backend = createMakaCuBackend({
    binaryPath: mockPath,
    imageDir,
    timeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    maxRestartAttempts: 2,
    restartBackoffMs: 5,
    ...(opts.physicalInputRecentlyActive
      ? { physicalInputRecentlyActive: opts.physicalInputRecentlyActive }
      : {}),
    ...(opts.allowCompatibilityInputDispatch === undefined
      ? {}
      : { allowCompatibilityInputDispatch: opts.allowCompatibilityInputDispatch }),
    ...(opts.onTrace ? { onTrace: opts.onTrace } : {}),
  });
  disposers.push(() => backend.dispose());
  return { backend, logPath, imageDir };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function observeFixture(
  backend: ReturnType<typeof createMakaCuBackend>,
): Promise<CuObservation> {
  return backend.observeApp!({ app: 'Fixture', includeScreenshot: true }, signal(), RUN_CONTEXT);
}

function boundCoordinate(observation: CuObservation): CuaBoundAction {
  return {
    frameId: observation.observationId,
    epoch: 0,
    actionFingerprint: 'left_click',
    fingerprint: 'bound-coordinate',
    target: {
      pid: observation.pid,
      windowId: observation.windowId,
      appName: observation.appId,
      bounds: observation.windowBounds!,
      sourceBoundsPx: observation.sourceBoundsPx!,
    },
    sourceCoordinate: { x: 400, y: 200 },
    windowCoordinate: { x: 400, y: 200 },
    coordinateSpace: 'window-screenshot-local',
  };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'maka-cu-test-'));
  mockPath = join(workDir, 'maka-cu-mock.cjs');
  await writeFile(mockPath, MOCK_SRC, 'utf8');
  chmodSync(mockPath, 0o755);
});

after(async () => {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* already gone */
    }
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('maka-cu backend', () => {
  it('opens with host.hello and refuses to move the system cursor', async () => {
    const { backend, logPath } = makeBackend();
    const permissions = await backend.preflight(signal());
    assert.deepEqual(permissions, { accessibility: true, screenRecording: true });

    const records = await readRecords(logPath);
    const hello = received(records, 'host.hello')[0];
    assert.equal(hello?.protocol, 'maka.cu/1');
    assert.equal(hello?.hostPid, process.pid);
    assert.equal(hello?.allowGlobalPointer, false);
    assert.equal(typeof hello?.imageDir, 'string');
    // §2: the first message on the connection, before anything else.
    assert.equal(records.filter((r) => r.kind === 'recv')[0]?.method, 'host.hello');
    assert.deepEqual(received(records, 'permissions.check')[0], { prompt: false });
  });

  it('fails loudly on a protocol version mismatch and does not retry', async () => {
    const { backend, logPath } = makeBackend({ protocol: 'maka.cu/99' });
    await assert.rejects(backend.preflight(signal()), /service_mismatch/);
    // §2: a mismatch is fatal. One spawn, no restart budget spent on an
    // executor that already declared it cannot talk this protocol.
    await delay(80);
    const records = await readRecords(logPath);
    assert.equal(records.filter((r) => r.kind === 'start').length, 1);
    assert.equal(received(records, 'session.begin').length, 0);
  });

  it('carries the snapshot id and element tokens into the observation identity', async () => {
    const traces: any[] = [];
    const { backend, logPath } = makeBackend({ onTrace: (event) => traces.push(event) });
    const observation = await observeFixture(backend);

    assert.match(observation.observationId, /^snap_/);
    assert.equal(observation.pid, 4711);
    assert.equal(observation.windowId, 90210);
    assert.equal(observation.appId, 'com.example.Fixture');
    // §4.3: the window digest already is the content fingerprint.
    assert.match(observation.contentFingerprint!, /^sha256:window_/);
    const button = observation.elements.find((element) => element.role === 'AXButton');
    assert.equal(button?.elementId, 'el_2');
    assert.equal(button?.identity?.token, 'el_2');
    assert.equal(button?.parentElementId, 'el_1');
    // §5: element frames are window-local logical points, not screen space.
    assert.deepEqual(button?.frame, { x: 20, y: 40, width: 72, height: 28 });
    assert.equal(observation.screenshot?.mimeType, 'image/png');
    assert.equal(observation.screenshot?.widthPx, 1200);
    assert.deepEqual(observation.displays?.[0]?.sourceBoundsPx, {
      x: 0,
      y: 0,
      width: 3024,
      height: 1964,
    });

    const records = await readRecords(logPath);
    const observeParams = received(records, 'observe')[0];
    assert.equal(observeParams?.session, RUN_CONTEXT.sessionId);
    // §5: a tagged union, never app + windowId as two optional fields.
    assert.deepEqual(observeParams?.target, { kind: 'app', app: 'Fixture' });
    // §5: bounds are omitted so the executor applies the ones it declared.
    assert.equal(observeParams?.maxElements, undefined);
    assert.equal(received(records, 'session.begin').length, 1);
    // §7.4 bounds reach the host even though CuObservation has no field for them.
    assert.equal(traces.find((event) => event.type === 'observe')?.truncatedElements, false);
  });

  it('echoes the element digest and returns the frame that superseded the quoted one', async () => {
    const { backend, logPath } = makeBackend();
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observation.observationId,
        elementId: 'el_2',
        elementIdentity: { token: 'el_2', role: 'AXButton' },
      },
      signal(),
      RUN_CONTEXT,
    );

    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.ok && result.outcome.tier, 'ax');
    // §6.5: verified is host-derived from effect, and is not a wire field.
    assert.equal(result.outcome.ok && result.outcome.verified, true);
    assert.equal(result.outcome.evidence?.path, 'ax_action');
    assert.equal(result.outcome.evidence?.effect, 'confirmed');
    assert.ok(result.observation, 'a fresh observation came back with the dispatch');
    assert.notEqual(result.observation!.observationId, observation.observationId);
    assert.ok(result.screenshot, 'the fresh frame is attached');

    const dispatch = received(await readRecords(logPath), 'dispatch.element')[0];
    assert.equal(dispatch?.snapshotId, observation.observationId);
    assert.equal(dispatch?.elementToken, 'el_2');
    // §4.3: echoing the digest catches a host that mixed up two snapshots.
    assert.equal(dispatch?.expectElementDigest, 'sha256:digest_2');
    assert.equal(dispatch?.strictness, 'element');
    // §6.1: a semantic dispatch addresses an element, not a pixel.
    assert.equal(dispatch?.occlusionPolicy, 'same_app');
    assert.deepEqual(dispatch?.action, { kind: 'click', button: 'left', count: 1 });
    assert.deepEqual(dispatch?.observeAfter, { includeImage: true, settle: 'quiesce' });
  });

  it('refuses a dispatch against a spent snapshot as a duplicate action', async () => {
    const { backend } = makeBackend({ dispatchError: 'snapshot_spent' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    // §7.1 maps snapshot_spent to duplicate_action, not to a generic failure.
    assert.equal(result.outcome.ok, false);
    assert.equal(!result.outcome.ok && result.outcome.error, 'duplicate_action');

    // §4.1: the spent frame is gone, so quoting it again is a stale frame.
    const again = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!again.outcome.ok && again.outcome.error, 'stale_frame');
  });

  it('reports an element whose reference died as target_missing and keeps the frame live', async () => {
    const { backend } = makeBackend({ dispatchError: 'element_released' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'target_missing');

    // §4.1: a refused dispatch does not spend its snapshot — the host may fix
    // the argument and retry against the same frame.
    const retry = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_1' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!retry.outcome.ok && retry.outcome.error, 'target_missing');
  });

  it('refuses an element token that was never in the quoted snapshot', async () => {
    const { backend, logPath } = makeBackend();
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_404' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'stale_frame');
    // Nothing reached the executor: there was no digest to echo.
    assert.equal(received(await readRecords(logPath), 'dispatch.element').length, 0);
  });

  it('rejects a tier/path pair outside the declared table instead of coercing it', async () => {
    const { backend } = makeBackend({ tier: 'ax', path: 'cg_event_pid' });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
    assert.match(result.outcome.ok ? '' : result.outcome.message, /does not permit path/);
  });

  it('treats a global-pointer path as a compromised session', async () => {
    const traces: any[] = [];
    const { backend } = makeBackend({
      tier: 'coordinate-background',
      path: 'cg_event_global',
      allowCompatibilityInputDispatch: true,
      onTrace: (event) => traces.push(event),
    });
    const observation = await observeFixture(backend);
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal(),
      { ...RUN_CONTEXT, boundAction: boundCoordinate(observation) },
    );
    // §6.3: the executor states the path and the host verifies it. A path that
    // was never permitted at handshake means the system cursor moved.
    assert.equal(!result.outcome.ok && result.outcome.error, 'service_mismatch');
    assert.match(result.outcome.ok ? '' : result.outcome.message, /moves the system cursor/);
    assert.ok(traces.some((event) => event.type === 'protocol_violation'));
  });

  it('anchors a coordinate dispatch to the window digest in image pixels', async () => {
    const { backend, logPath } = makeBackend({
      tier: 'coordinate-background',
      path: 'cg_event_pid',
      allowCompatibilityInputDispatch: true,
    });
    const observation = await observeFixture(backend);
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal(),
      { ...RUN_CONTEXT, boundAction: boundCoordinate(observation) },
    );
    assert.equal(result.outcome.ok, true);
    assert.equal(result.outcome.ok && result.outcome.tier, 'coordinate-background');

    const dispatch = received(await readRecords(logPath), 'dispatch.point')[0];
    assert.equal(dispatch?.snapshotId, observation.observationId);
    // §6.3: a point has no element to anchor to, so the window is the anchor.
    assert.equal(dispatch?.expectWindowDigest, observation.contentFingerprint);
    assert.equal(dispatch?.space, 'image_px');
    assert.equal(dispatch?.occlusionPolicy, 'any');
    assert.deepEqual(dispatch?.point, { x: 400, y: 200 });
  });

  it('keeps coordinate dispatch closed unless the host policy opens it', async () => {
    const { backend, logPath } = makeBackend({
      tier: 'coordinate-background',
      path: 'cg_event_pid',
    });
    const observation = await observeFixture(backend);
    const result = await backend.run(
      { type: 'left_click', coordinate: { x: 400, y: 200 } },
      signal(),
      { ...RUN_CONTEXT, boundAction: boundCoordinate(observation) },
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'unsupported_action');
    assert.equal(received(await readRecords(logPath), 'dispatch.point').length, 0);
  });

  it('fences a dispatch while the user is physically active', async () => {
    const { backend, logPath } = makeBackend({ physicalInputRecentlyActive: () => true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'user_intervened');
    assert.equal(received(await readRecords(logPath), 'dispatch.element').length, 0);
  });

  it('rejects a frame whose bytes do not match the declared digest', async () => {
    const { backend } = makeBackend({ badImageSha: true });
    // §8: the host verifies, so a stale path can never return a previous
    // frame's pixels under a fresh snapshot's name.
    await assert.rejects(observeFixture(backend), /sha256|digest/);
  });

  it('reports a delivered dispatch with no fresh frame as outcome_unknown', async () => {
    const { backend } = makeBackend({ noPostSnapshot: true });
    const observation = await observeFixture(backend);
    const result = await backend.runSemantic!(
      { type: 'click_element', observationId: observation.observationId, elementId: 'el_2' },
      signal(),
      RUN_CONTEXT,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'outcome_unknown');
    assert.equal(result.outcome.evidence?.effect, 'unverifiable');
  });

  it('ends the executor session when the host clears it', async () => {
    const { backend, logPath } = makeBackend();
    await observeFixture(backend);
    backend.clearSession(RUN_CONTEXT.sessionId);
    await delay(120);
    const records = await readRecords(logPath);
    assert.deepEqual(received(records, 'session.end')[0], { session: RUN_CONTEXT.sessionId });
  });

  it('maps apps.list onto CuAppSummary without a rendered catalogue', async () => {
    const { backend } = makeBackend();
    const apps = await backend.listApps!(signal());
    assert.deepEqual(apps, [
      { appId: 'com.example.Fixture', pid: 4711, name: 'Fixture', windowCount: 1 },
    ]);
  });
});

describe('maka-cu backend selection', () => {
  it('is off unless it is asked for by name', () => {
    if (process.platform !== 'darwin') return;
    let madeMakaCu = 0;
    let madeCuaDriver = 0;
    const stub = () => ({
      preflight: async () => ({ accessibility: false, screenRecording: false }),
    });
    const deps = {
      binaryPath: '/tmp/does-not-matter',
      expectedBinarySha256: 'deadbeef',
      createBackend: () => {
        madeCuaDriver += 1;
        return stub() as never;
      },
      createMakaCuBackend: () => {
        madeMakaCu += 1;
        return stub() as never;
      },
    };

    const byDefault = selectComputerUseBackend(deps);
    assert.equal(byDefault.backendId, 'cua-driver');
    assert.equal(madeMakaCu, 0);
    assert.equal(madeCuaDriver, 1);

    const explicit = selectComputerUseBackend({ ...deps, backendId: 'maka-cu' as const });
    assert.equal(explicit.backendId, 'maka-cu');
    assert.equal(madeMakaCu, 1);
    assert.equal(madeCuaDriver, 1);
  });
});
