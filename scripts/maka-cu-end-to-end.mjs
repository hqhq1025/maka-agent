#!/usr/bin/env node
// End to end: Maka's own TypeScript backend driving the real maka-cu executor
// against a real window. Everything before this proved one side at a time —
// the executor answered a hand-written probe, and the client answered a mock.
// Neither proves they agree.
//
// Read-only with respect to permissions: preflight does not prompt.
// Presses Primary Button, never Reset: the fixture's Reset handler activates
// its own app, which would fail the foreground check for a reason that has
// nothing to do with anything here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = '/Users/haoqing/Documents/Github/maka-agent/.claude/worktrees/wf_eeaac75f-836-3';
const BINARY = '/Users/haoqing/Documents/Github/maka-cu/.build/release/OpenComputerUse';
const APP = process.argv[2] ?? 'Codex CUA Lab';

const { selectComputerUseBackend } = await import(`${ROOT}/packages/computer-use/dist/index.js`);

function frontmost() {
  try {
    return execFileSync(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get unix id of first process whose frontmost is true',
      ],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
  } catch {
    return 'unavailable';
  }
}

let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const traces = [];
const selected = selectComputerUseBackend({
  backendId: 'maka-cu',
  binaryPath: BINARY,
  // The selector refuses to spawn a binary it cannot verify, which is right.
  // There is no upstream release to pin against yet, so this pins what was just
  // built — it proves the check runs, not that the artifact is trustworthy.
  // Trustworthy is the shipping pipeline's job.
  expectedBinarySha256: createHash('sha256').update(readFileSync(BINARY)).digest('hex'),
  onMakaCuTrace: (event) => traces.push(event),
  physicalInputRecentlyActive: () => false,
});

console.log(`backendId = ${selected.backendId}`);
check('the maka-cu backend was selected', selected.backendId === 'maka-cu', selected.backendId);
if (!selected.backend) {
  console.log('no backend was constructed; stopping.');
  process.exit(2);
}

const backend = selected.backend;
const signal = new AbortController().signal;
const context = { sessionId: 'e2e', turnId: 't1', toolCallId: 'e2e-1' };

try {
  const tcc = await backend.preflight(signal);
  console.log(
    `permissions: accessibility=${tcc.accessibility} screenRecording=${tcc.screenRecording}`,
  );
  if (!tcc.accessibility) {
    console.log('Accessibility not granted; stopping.');
    process.exit(2);
  }

  const apps = await backend.listApps(signal);
  check('listApps returns apps', apps.length > 0, `${apps.length} apps`);
  const target = apps.find((a) => a.name === APP || a.appId === APP);
  check(
    `the fixture "${APP}" is running`,
    Boolean(target),
    target ? JSON.stringify(target) : 'not found',
  );
  if (!target) process.exit(2);

  const before = frontmost();
  check(
    'the fixture is NOT frontmost, so this is a background run',
    String(before) !== String(target.pid),
    `frontmost=${before} target=${target.pid}`,
  );

  // ── observe, through Maka's own observation shape ─────────────────────────
  const observation = await backend.observeApp(
    { app: target.appId, includeScreenshot: false },
    signal,
    context,
  );
  check(
    'observeApp returns a CuObservation',
    Boolean(observation?.observationId),
    observation?.observationId,
  );
  check(
    'the observation names the window',
    Boolean(observation.windowTitle),
    observation.windowTitle ?? '',
  );
  check(
    'elements arrived',
    observation.elements.length > 0,
    `${observation.elements.length} elements`,
  );

  const identified = observation.elements.filter((e) => e.identity?.token);
  check(
    'every element carries its binding identity into the runtime type',
    identified.length === observation.elements.length,
    `${identified.length}/${observation.elements.length}`,
  );

  // Ruling F: the wire is window-local, CuObservedElement.frame is screen
  // logical points. A window at a non-zero origin proves the conversion ran.
  const framed = observation.elements.filter((e) => e.frame);
  const originX = observation.windowBounds?.x ?? 0;
  const insideWindow = framed.filter(
    (e) =>
      e.frame.x >= originX - 1 &&
      e.frame.x <= originX + (observation.windowBounds?.width ?? 1e9) + 1,
  );
  check(
    'element frames are in screen space, not window-local',
    originX === 0 || insideWindow.length === framed.length,
    `window origin x=${originX}, ${insideWindow.length}/${framed.length} frames inside it`,
  );

  // ── act ───────────────────────────────────────────────────────────────────
  const button =
    observation.elements.find((e) => e.label === 'CUA Lab Primary Button') ??
    observation.elements.find((e) => e.role === 'AXButton' && e.label !== 'CUA Lab Reset');
  check('a pressable element is present', Boolean(button), button?.label ?? 'none');

  const result = await backend.runSemantic(
    {
      type: 'click_element',
      observationId: observation.observationId,
      elementId: button.elementId,
    },
    signal,
    { ...context, toolCallId: 'e2e-2' },
  );
  check(
    'click_element succeeds through the runtime seam',
    result.outcome.ok === true,
    result.outcome.ok
      ? `tier=${result.outcome.tier} verified=${result.outcome.verified}`
      : `${result.outcome.error}: ${result.outcome.message ?? ''}`,
  );
  check(
    'the action carries a fresh observation back',
    Boolean(result.observation?.observationId),
    `${result.observation?.elements?.length ?? 0} elements`,
  );

  // ── the frame binding, through Maka's own protocol ────────────────────────
  const replay = await backend.runSemantic(
    {
      type: 'click_element',
      observationId: observation.observationId,
      elementId: button.elementId,
    },
    signal,
    { ...context, toolCallId: 'e2e-3' },
  );
  check(
    'replaying the spent observation is refused',
    replay.outcome.ok === false,
    replay.outcome.ok ? 'IT WENT THROUGH' : `${replay.outcome.error}`,
  );

  const after = frontmost();
  check(
    'the run did not steal the foreground',
    String(after) === String(before),
    `${before} → ${after}`,
  );

  const dispatches = traces.filter((t) => t.type === 'dispatch');
  console.log(`\ntraces: ${traces.length} (${dispatches.length} dispatch)`);
  for (const trace of traces.slice(-4)) console.log(`  ${JSON.stringify(trace).slice(0, 180)}`);
} catch (error) {
  failures += 1;
  console.log(`\n[ERROR] ${error?.stack ?? error?.message ?? error}`);
} finally {
  backend.dispose?.();
}

console.log(failures === 0 ? '\nEND TO END OK' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
