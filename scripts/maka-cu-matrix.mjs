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
  process.env.MAKA_CU_BINARY ??
  '/Users/haoqing/Documents/Github/maka-cu/.build/release/OpenComputerUse';
const APP_ID = process.argv[2] ?? 'com.openai.codex.cualab';

const { selectComputerUseBackend } = await import(`${ROOT}/packages/computer-use/dist/index.js`);

const frontmost = () => {
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
  binaryPath: BINARY,
  expectedBinarySha256: createHash('sha256').update(readFileSync(BINARY)).digest('hex'),
  onTrace: (event) => traces.push(event),
  physicalInputRecentlyActive: () => false,
  // The key actions are the ones that synthesize input; without this they are
  // refused before the executor is asked, and the run proves nothing about them.
  allowCompatibilityInputDispatch: true,
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
  outcome.ok
    ? `tier=${outcome.tier} verified=${outcome.verified}`
    : `${outcome.error}: ${outcome.message ?? ''}`;

try {
  const tcc = await backend.preflight(signal);
  check(
    'Accessibility and Screen Recording are already granted',
    tcc.accessibility === true,
    JSON.stringify(tcc),
  );
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
  check(
    'the target is in the background',
    String(before) !== String(target.pid),
    `${before} ≠ ${target.pid}`,
  );

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
  check(
    'the observation carries the window it describes',
    Boolean(first.windowTitle ?? first.windowBounds),
  );

  const buttons = byRole(first, 'AXButton');
  check('the tree reaches real controls', buttons.length > 0, `${buttons.length} buttons`);

  // ── 3. element actions, the advertised set ───────────────────────────────
  //
  // The first AXButton in a window's tree is usually one of the traffic lights,
  // and pressing it closes the window this run is measuring — or, in an app
  // that is not a calculator, sends something. A harness that can be pointed at
  // an arbitrary app has to refuse the controls whose effect is not local, and
  // say so rather than picking one anyway.
  const DESTRUCTIVE =
    /关闭|关掉|退出|结束|删除|清除|清空|移除|废纸篓|丢弃|不存储|不保存|发送|提交|购买|支付|注销|重置|恢复出厂|close|quit|exit|delete|remove|discard|trash|send|submit|reset|sign\s*out|log\s*out|buy|pay|don'?t save/i;
  const inert = (element) => {
    const label = String(element.label ?? '').trim();
    // An unlabelled button cannot be judged, and the traffic lights are often
    // exactly that. Unknown effect is treated as unsafe, not as safe.
    if (!label) return false;
    return !DESTRUCTIVE.test(label);
  };
  const clickTarget = buttons.find(inert);
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
    check(
      'click_element on a real control',
      clicked?.outcome.ok === true,
      clicked ? describe(clicked.outcome) : 'not found again',
    );

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
    skip(
      'click_element',
      buttons.length > 0
        ? `${buttons.length} buttons, none of them safe to press here`
        : 'no button in the tree',
    );
  }

  // set_value, on whatever text field the app exposes.
  const fieldObs = await observe();
  // A disabled field refuses `set_value`, and correctly so — Preview's toolbar
  // search field is one, and aiming at it turned three honest refusals into
  // three red checks. The observation already says which fields are live.
  const isField = (e) => e.role === 'AXTextField' || e.role === 'AXTextArea';
  const field =
    fieldObs.elements.find((e) => isField(e) && e.enabled !== false) ??
    (fieldObs.elements.some(isField) ? 'disabled-only' : undefined);
  if (field === 'disabled-only') {
    skip('set_value / select_text', 'the only text fields in the tree are disabled');
  } else if (field) {
    // Whatever was in the field belongs to the user, not to this run.
    const previous = typeof field.value === 'string' ? field.value : '';
    const typed = `mcu-${call}`;
    const written = await backend.runSemantic(
      {
        type: 'set_value',
        observationId: fieldObs.observationId,
        elementId: field.elementId,
        value: typed,
      },
      signal,
      ctx(),
    );
    check('set_value on a real text field', written.outcome.ok === true, describe(written.outcome));
    const readBack = await observe();
    const same = readBack.elements.find((e) => e.label === field.label && e.role === field.role);
    check(
      'the written value survives a fresh observation',
      same?.value === typed,
      `reads ${JSON.stringify(same?.value ?? '')}`,
    );

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

    // Put back what was there. A matrix that leaves `mcu-7` in a field the user
    // was typing in has stopped being read-only about their work, and the next
    // run would then measure against its own leftovers.
    const restoreObs = await observe();
    const restoreField = restoreObs.elements.find(
      (e) => e.role === field.role && e.label === field.label,
    );
    if (restoreField) {
      const restored = await backend.runSemantic(
        {
          type: 'set_value',
          observationId: restoreObs.observationId,
          elementId: restoreField.elementId,
          value: previous,
        },
        signal,
        ctx(),
      );
      check(
        'the field is left as it was found',
        restored.outcome.ok === true,
        `restored ${JSON.stringify(previous)}`,
      );
    }
  } else {
    skip('set_value / select_text', 'no text field in the tree');
  }

  // secondary_action, named from the protocol's closed set rather than left
  // undefined — an undefined action proves the argument check, not the action.
  const secondaryObs = await observe();
  const secondaryTarget = secondaryObs.elements.filter((e) => e.role === 'AXButton').find(inert);
  if (secondaryTarget) {
    const out = await backend.runSemantic(
      {
        type: 'secondary_action',
        observationId: secondaryObs.observationId,
        elementId: secondaryTarget.elementId,
        action: 'show_menu',
      },
      signal,
      ctx(),
    );
    check(
      'secondary_action either succeeds or names why not',
      out.outcome.ok === true || typeof out.outcome.error === 'string',
      describe(out.outcome),
    );
  }

  // scroll_element — the semantic member, which takes pages. `scroll` is the
  // coordinate action and is not an element action; asking for it here passed
  // by naming its own absence, which is not a test of anything.
  const scrollObs = await observe();
  const scrollable =
    scrollObs.elements.find((e) => e.role === 'AXScrollArea') ?? scrollObs.elements[0];
  if (scrollable) {
    const out = await backend.runSemantic(
      {
        type: 'scroll_element',
        observationId: scrollObs.observationId,
        elementId: scrollable.elementId,
        direction: 'down',
        pages: 1,
      },
      signal,
      ctx(),
    );
    check(
      'scroll_element either succeeds or names why not',
      out.outcome.ok === true || typeof out.outcome.error === 'string',
      describe(out.outcome),
    );
    // Whatever the element answers, it must not be "Maka cannot express this".
    check(
      'scroll_element is an element action the host can express',
      out.outcome.ok === true || out.outcome.message?.includes('is not an element action') !== true,
      describe(out.outcome),
    );
  }

  // press_key naming the control it is for. The executor takes focus only when
  // the host asks it to, so this is the path the tool description promises.
  const keyObs = await observe();
  // A text field is the control this promise is actually about, and it is also
  // the one whose digest does not cover half the window — naming a container
  // means any unrelated change refuses the key, which measures the frame
  // binding rather than the focus policy.
  const keyTarget =
    keyObs.elements.find((e) => e.role === 'AXTextField' || e.role === 'AXTextArea') ??
    keyObs.elements.filter((e) => e.role === 'AXButton').find(inert);
  if (keyTarget) {
    const out = await backend.runSemantic(
      {
        type: 'press_key',
        observationId: keyObs.observationId,
        key: 'Escape',
        elementId: keyTarget.elementId,
      },
      signal,
      ctx(),
    );
    check(
      'press_key with an element id reaches the executor',
      out.outcome.ok === true || typeof out.outcome.error === 'string',
      describe(out.outcome),
    );
    // Either it reached the executor with the focus policy the promise implies,
    // or it was refused for a reason the model can act on. What must not happen
    // is a key that quietly does nothing.
    const keyDispatch = traces.filter((t) => t.type === 'dispatch' && t.method === 'dispatch.key');
    check(
      'a key that names a control either acquires focus or says why not',
      out.outcome.ok === true
        ? keyDispatch.length > 0
        : typeof out.outcome.error === 'string' && out.outcome.error.length > 0,
      out.outcome.ok === true ? `${keyDispatch.length} key dispatches` : describe(out.outcome),
    );
  } else {
    skip('press_key with an element id', 'no field or safe control to aim at');
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
      check(
        'and they can be pressed, so the run leaves nothing open',
        dismissed.outcome.ok === true,
        describe(dismissed.outcome),
      );
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
    {
      type: 'click_element',
      observationId: 'observation-that-never-existed',
      elementId: staleTarget.elementId,
    },
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

  // launch_app, on an app that is not running. The invariant is not "it
  // started" — it is "it started and the user kept their focus", which is the
  // whole reason a background launch exists.
  const LAUNCH_TARGET = process.env.MAKA_CU_LAUNCH_TARGET ?? 'TextEdit';
  const beforeLaunch = frontmost();
  const launched = await backend.launchApp?.({ app: LAUNCH_TARGET }, signal, ctx());
  if (launched) {
    check(
      'launch_app resolves the app id the executor owns',
      typeof launched.bundleId === 'string' && launched.bundleId.includes('.'),
      `${LAUNCH_TARGET} → ${launched.bundleId} pid ${launched.pid}`,
    );
    // The executor waits for a window rather than reporting the empty array it
    // sees at launch time; an empty array here means that wait did not happen.
    check(
      'launch_app waited for a window instead of reporting none',
      launched.windows.length > 0,
      `${launched.windows.length} windows`,
    );
    // `focusHeld` was a vacuous pass until the executor stopped reading a frozen
    // `frontmostApplication`: it could only ever answer "no foreground taken",
    // so asserting that answer proved nothing. The independent check is the
    // host's own frontmost reading across the launch, which is why both are here.
    const afterLaunch = frontmost();
    check(
      'launching did not take the foreground',
      launched.focusHeld === true && afterLaunch === beforeLaunch,
      `focusHeld=${launched.focusHeld}, frontmost ${beforeLaunch} → ${afterLaunch}`,
    );
  } else {
    skip('launch_app', 'the backend exposes no launchApp');
  }

  const dispatches = traces.filter((t) => t.type === 'dispatch');
  const pixel = dispatches.filter((t) => t.path && !String(t.path).startsWith('ax'));
  // Zero dispatches would satisfy "none of them were pixels" while proving
  // nothing, and it did: the trace option was passed under the name the
  // two-backend selector used, so every dispatch went unrecorded and the check
  // passed on an empty list. Assert the evidence exists before reading it.
  check(
    'the run actually dispatched something to look at',
    dispatches.length > 0,
    `${dispatches.length} dispatches recorded`,
  );
  const elementDispatches = dispatches.filter((t) => t.method === 'dispatch.element');
  check(
    'every element dispatch took an accessibility path',
    elementDispatches.length > 0 && elementDispatches.every((t) => String(t.path).startsWith('ax')),
    `${elementDispatches.length} element dispatches, ` +
      `${elementDispatches.filter((t) => !String(t.path).startsWith('ax')).length} non-ax`,
  );
  // Keys are synthesized by definition, so they are not on an AX path and are
  // not meant to be. The invariant that does cover them is narrower and is the
  // one that matters: nothing may reach the global event tap, because that is
  // what moves the user's own pointer and steals their own focus.
  const global = dispatches.filter((t) => String(t.path) === 'cg_event_global');
  check(
    'no dispatch reached the global event tap',
    global.length === 0,
    `${dispatches.length} dispatches, ${pixel.length} off the AX path, ${global.length} global`,
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
