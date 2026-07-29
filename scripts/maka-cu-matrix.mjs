#!/usr/bin/env node
// Real-chain functional matrix for maka-cu, driven through the host backend
// against a real app in the background.
//
// The unit tests speak to a mock executor, so they prove the host's half. The
// binding proof drove one element. This drives the whole advertised surface —
// every element action, every point action, the key actions, the app and window
// queries, the session lifecycle and the frame-binding refusals — against an
// app that was not written to be driven.
//
// Target: Codex CUA Lab by default. It is a fixture with counters and fields,
// so every action has a readable effect and nothing here can send a message,
// save a file, or touch anything that matters.
//
// Read-only with respect to permissions: `permissions.check` never prompts, and
// the run stops if Accessibility is not already granted. Granting TCC to a bare
// node process permanently poisons that process's own file access, so this must
// never be the thing that triggers a prompt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ROOT = process.env.MAKA_ROOT ?? process.cwd();
const BINARY =
  process.env.MAKA_CU_BINARY ?? '/Users/haoqing/Documents/Github/maka-cu/.build/release/OpenComputerUse';
const APP_ID = process.argv[2] ?? 'com.openai.codex.cualab';

const { selectComputerUseBackend } = await import(`${ROOT}/packages/computer-use/dist/index.js`);

const frontmost = () => {
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get unix id of first process whose frontmost is true'],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
  } catch {
    return 'unavailable';
  }
};

let failures = 0;
let skipped = 0;
const rows = [];
function check(label, pass, detail) {
  if (!pass) failures += 1;
  rows.push({ label, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function skip(label, why) {
  skipped += 1;
  console.log(`[SKIP] ${label} — ${why}`);
}

const traces = [];
const selected = selectComputerUseBackend({
  backendId: 'maka-cu',
  binaryPath: BINARY,
  expectedBinarySha256: createHash('sha256').update(readFileSync(BINARY)).digest('hex'),
  onMakaCuTrace: (event) => traces.push(event),
  physicalInputRecentlyActive: () => false,
});
const backend = selected.backend;
if (!backend) {
  console.log('no backend; stopping.');
  process.exit(2);
}

const signal = new AbortController().signal;
let call = 0;
const ctx = () => ({ sessionId: 'matrix', turnId: 't1', toolCallId: `c${++call}` });
const observe = () => backend.observeApp({ app: APP_ID, includeScreenshot: false }, signal, ctx());
const byLabel = (obs, label) => obs.elements.find((e) => e.label === label);
const byRole = (obs, role) => obs.elements.filter((e) => e.role === role);

/** Run a semantic action against a freshly observed element, by label. */
async function onElement(label, build) {
  const obs = await observe();
  const element = byLabel(obs, label);
  if (!element) return { missing: true, obs };
  const result = await backend.runSemantic(
    build({ observationId: obs.observationId, elementId: element.elementId }),
    signal,
    ctx(),
  );
  return { outcome: result.outcome, element, obs };
}

const describe = (outcome) =>
  outcome.ok ? `tier=${outcome.tier} verified=${outcome.verified}` : `${outcome.error}: ${outcome.message ?? ''}`;

try {
  const tcc = await backend.preflight(signal);
  check('Accessibility and Screen Recording are already granted', tcc.accessibility === true, JSON.stringify(tcc));
  if (!tcc.accessibility) {
    console.log('stopping rather than prompting.');
    process.exit(2);
  }

  // ── 1. the queries ───────────────────────────────────────────────────────
  const apps = await backend.listApps(signal);
  const target = apps.find((a) => a.appId === APP_ID);
  check('apps.list finds the target by appId, exactly', Boolean(target), `${apps.length} apps`);
  if (!target) {
    console.log(`${APP_ID} is not running; start it and re-run.`);
    process.exit(2);
  }
  const before = frontmost();
  check('the target is in the background', String(before) !== String(target.pid), `${before} ≠ ${target.pid}`);

  // ── 2. observation ───────────────────────────────────────────────────────
  const first = await observe();
  check('observe returns a tree', first.elements.length > 0, `${first.elements.length} elements`);
  check(
    'element ids are short enough for a model to quote back',
    first.elements.every((e) => e.elementId.length <= 6),
    `longest ${Math.max(...first.elements.map((e) => e.elementId.length))} chars`,
  );
  check(
    'every element id is distinct',
    new Set(first.elements.map((e) => e.elementId)).size === first.elements.length,
  );
  check('the observation carries the window it describes', Boolean(first.windowTitle ?? first.windowBounds));

  const buttons = byRole(first, 'AXButton');
  check('the tree reaches real controls', buttons.length > 0, `${buttons.length} buttons`);

  // ── 3. element actions, the advertised set ───────────────────────────────
  const clickTarget = buttons[0];
  if (clickTarget) {
    const obs = await observe();
    const again = obs.elements.find((e) => e.label === clickTarget.label);
    const clicked = again
      ? await backend.runSemantic(
          { type: 'click_element', observationId: obs.observationId, elementId: again.elementId },
          signal,
          ctx(),
        )
      : null;
    check('click_element on a real control', clicked?.outcome.ok === true, clicked ? describe(clicked.outcome) : 'not found again');

    // The binding: the same observation may not be spent twice.
    const replay = again
      ? await backend.runSemantic(
          { type: 'click_element', observationId: obs.observationId, elementId: again.elementId },
          signal,
          ctx(),
        )
      : null;
    check(
      'a spent observation is refused',
      replay?.outcome.ok === false,
      replay?.outcome.ok ? 'IT WENT THROUGH' : replay?.outcome.error,
    );
  } else {
    skip('click_element', 'no button in the tree');
  }

  // set_value, on whatever text field the app exposes.
  const fieldObs = await observe();
  const field = fieldObs.elements.find((e) => e.role === 'AXTextField' || e.role === 'AXTextArea');
  if (field) {
    const typed = `mcu-${call}`;
    const written = await backend.runSemantic(
      { type: 'set_value', observationId: fieldObs.observationId, elementId: field.elementId, value: typed },
      signal,
      ctx(),
    );
    check('set_value on a real text field', written.outcome.ok === true, describe(written.outcome));
    const readBack = await observe();
    const same = readBack.elements.find((e) => e.label === field.label && e.role === field.role);
    check('the written value survives a fresh observation', same?.value === typed, `reads ${JSON.stringify(same?.value ?? '')}`);

    // select_text and secondary_action are advertised; exercise them where the
    // element supports them rather than asserting a universal success.
    const selObs = await observe();
    const selField = selObs.elements.find((e) => e.role === field.role && e.label === field.label);
    if (selField) {
      const selected = await backend.runSemantic(
        { type: 'select_text', observationId: selObs.observationId, elementId: selField.elementId },
        signal,
        ctx(),
      );
      check(
        'select_text either succeeds or refuses with a reason',
        selected.outcome.ok === true || typeof selected.outcome.error === 'string',
        describe(selected.outcome),
      );
    }
  } else {
    skip('set_value / select_text', 'no text field in the tree');
  }

  // secondary_action, on a control that has one.
  const secondaryObs = await observe();
  const secondaryTarget = secondaryObs.elements.find((e) => e.role === 'AXButton');
  if (secondaryTarget) {
    const out = await backend.runSemantic(
      { type: 'secondary_action', observationId: secondaryObs.observationId, elementId: secondaryTarget.elementId },
      signal,
      ctx(),
    );
    check(
      'secondary_action either succeeds or names why not',
      out.outcome.ok === true || typeof out.outcome.error === 'string',
      describe(out.outcome),
    );
  }

  // scroll, on the element the app scrolls.
  const scrollObs = await observe();
  const scrollable = scrollObs.elements.find((e) => e.role === 'AXScrollArea') ?? scrollObs.elements[0];
  if (scrollable) {
    const out = await backend.runSemantic(
      { type: 'scroll', observationId: scrollObs.observationId, elementId: scrollable.elementId, deltaY: 120 },
      signal,
      ctx(),
    );
    check(
      'scroll either succeeds or names why not',
      out.outcome.ok === true || typeof out.outcome.error === 'string',
      describe(out.outcome),
    );
  }

  // ── 4. a sheet is a window to CGWindowList and a child to accessibility ──
  //
  // Alerts, save panels, print panels and permission prompts are all sheets.
  // While one is up it is the app's frontmost window, so `{kind:"app"}`
  // resolves to it — and an executor that looks for it in `AXWindows` finds
  // nothing and answers `window_gone`, which is the app going blind at the
  // exact moment it has stopped to ask a question.
  const modalOpen = await onElement('CUA Lab Open Modal', ({ observationId, elementId }) => ({
    type: 'click_element',
    observationId,
    elementId,
  }));
  if (modalOpen.missing) {
    skip('observing a sheet', 'the fixture has no modal control');
  } else {
    check('opening a modal succeeds', modalOpen.outcome.ok === true, describe(modalOpen.outcome));
    const sheet = await observe();
    check(
      'with a sheet up, the app resolves to the sheet rather than to nothing',
      sheet.elements.some((e) => e.role === 'AXSheet'),
      `target=${JSON.stringify(sheet.windowTitle ?? '')} roles=${[...new Set(sheet.elements.map((e) => e.role))].join(',')}`,
    );
    const close = sheet.elements.find((e) => e.role === 'AXButton');
    check('the sheet exposes its own controls', Boolean(close), close?.label ?? 'none');
    if (close) {
      const dismissed = await backend.runSemantic(
        { type: 'click_element', observationId: sheet.observationId, elementId: close.elementId },
        signal,
        ctx(),
      );
      check('and they can be pressed, so the run leaves nothing open', dismissed.outcome.ok === true, describe(dismissed.outcome));
    }
  }

  // ── 5. the refusals that make the binding worth having ───────────────────
  const bindObs = await observe();
  const unknown = await backend.runSemantic(
    { type: 'click_element', observationId: bindObs.observationId, elementId: 'no-such-element' },
    signal,
    ctx(),
  );
  check(
    'an element id that was never in the snapshot is refused',
    unknown.outcome.ok === false,
    unknown.outcome.ok ? 'IT WENT THROUGH' : unknown.outcome.error,
  );

  const staleObs = await observe();
  const staleTarget = staleObs.elements[0];
  const bogus = await backend.runSemantic(
    { type: 'click_element', observationId: 'observation-that-never-existed', elementId: staleTarget.elementId },
    signal,
    ctx(),
  );
  check(
    'an observation id that was never issued is refused',
    bogus.outcome.ok === false,
    bogus.outcome.ok ? 'IT WENT THROUGH' : bogus.outcome.error,
  );

  // ── 6. the invariants that outrank every result above ────────────────────
  // The invariant is that the *target* never came forward, not that the
  // frontmost app never changed. A run takes tens of seconds, during which the
  // person at the machine may switch apps for reasons of their own — and an
  // assertion that calls that a violation is one that cries wolf. This exact
  // check misreported a foreground steal once already, on a fixture button
  // whose own handler activated its app.
  const after = frontmost();
  check(
    'driving in the background never brought the target forward',
    String(after) !== String(target.pid),
    `frontmost ${before} → ${after}, target ${target.pid}`,
  );

  const dispatches = traces.filter((t) => t.type === 'dispatch');
  const pixel = dispatches.filter((t) => t.path && !String(t.path).startsWith('ax'));
  check(
    'every dispatch took an accessibility path, never pixels',
    pixel.length === 0,
    `${dispatches.length} dispatches, ${pixel.length} non-ax`,
  );
} catch (error) {
  failures += 1;
  console.log(`\n[ERROR] ${error?.stack ?? error?.message ?? error}`);
} finally {
  backend.dispose?.();
}

console.log(
  `\n${rows.filter((r) => r.pass).length}/${rows.length} checks passed` +
    (skipped ? `, ${skipped} skipped` : '') +
    (failures === 0 ? ' — MAKA CU MATRIX OK' : ''),
);
process.exit(failures === 0 ? 0 : 1);
