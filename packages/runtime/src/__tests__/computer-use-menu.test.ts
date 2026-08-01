// The menu bar as the model reads it.
//
// Against a five-model, six-task real-machine matrix, three of the four tasks
// that failed for every model failed on one fact: no observation this executor
// produced contained a single menu element. Save as PDF, find in project and
// rotate image are menu commands and nothing in a window reaches them.
//
// Shipping the menu is not the same as shipping it usably. A whole menu bar is
// larger than most windows — TextEdit's is 369 elements against 16 — so what is
// asserted here is the shape that makes it affordable to carry on every
// observation, and the sentence without which a model cannot act on it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderObservationForModel } from '../computer-use-observation-text.js';
import type { CuObservation, CuObservedElement } from '../computer-use-types.js';

function element(
  elementId: string,
  role: string,
  extra: Partial<CuObservedElement> = {},
): CuObservedElement {
  return { elementId, role, ...extra };
}

/** A window with a menu bar beside it, shaped the way maka-cu reports one. */
function observation(overrides: Partial<CuObservation> = {}): CuObservation {
  return {
    observationId: 'obs_1',
    appId: 'com.apple.TextEdit',
    pid: 1,
    windowId: 2,
    elements: [
      element('0', 'AXWindow', { label: 'note.txt' }),
      element('1', 'AXTextArea', { parentElementId: '0', value: 'hi' }),
      // An ordinary window control whose role starts with AXMenu. TextEdit has
      // one: 文稿操作. Splitting the menu out by role prefix would move it.
      element('2', 'AXMenuButton', { parentElementId: '0', label: '文稿操作' }),
      element('3', 'AXMenuBar'),
      element('4', 'AXMenuBarItem', { parentElementId: '3', label: '文件' }),
      element('5', 'AXMenu', { parentElementId: '4' }),
      element('6', 'AXMenuItem', { parentElementId: '5', label: '新建' }),
      element('7', 'AXMenuItem', { parentElementId: '5', enabled: false }),
      element('8', 'AXMenuItem', { parentElementId: '5', label: '导出为PDF…', enabled: false }),
      element('9', 'AXMenuBarItem', { parentElementId: '3', label: '编辑' }),
    ],
    ...overrides,
  } as CuObservation;
}

test('a window control whose role begins with AXMenu stays in the window', () => {
  const text = renderObservationForModel(observation());
  const [windowPart, menuPart] = text.split(/^menu_bar=/m);
  assert.match(windowPart ?? '', /文稿操作/);
  assert.doesNotMatch(menuPart ?? '', /文稿操作/);
  // And the header counts the window, not the whole observation: a model told
  // `elements=10` and shown two lists cannot tell which number it was.
  assert.match(text, /elements=3$/m);
});

test('the empty container between a menu title and its commands is gone', () => {
  const text = renderObservationForModel(observation());
  // `AXMenu` carries no name, no state and nothing to act on. Removing it is
  // what makes an opened menu read the way a menu looks.
  assert.doesNotMatch(text, /AXMenu\b(?!Bar|Item|Button)/);
  const lines = text.split('\n');
  const title = lines.findIndex((line) => line.includes('"文件"'));
  const command = lines.findIndex((line) => line.includes('"新建"'));
  assert.ok(title >= 0 && command > title);
  // One level of indentation between them, not two.
  const depth = (line: string) => line.match(/^\t*/)?.[0].length ?? 0;
  assert.equal(depth(lines[command] ?? ''), depth(lines[title] ?? '') + 1);
});

test('a separator is not written down, and the command after it keeps its id', () => {
  const text = renderObservationForModel(observation());
  // An unnamed, disabled, actionless, childless AXMenuItem is AppKit's
  // separator line. TextEdit's 文件 menu is 8 of 42, its 格式 menu 11 of 72.
  assert.doesNotMatch(text, /^\s*7 AXMenuItem\s*$/m);
  // The rule is narrower than "drop what has no label", which was measured
  // against window trees and rejected: 1,023 unnamed but operable elements
  // across ten applications, and no pixel fallback to reach one that was hid.
  assert.match(text, /8 AXMenuItem "导出为PDF…" \[disabled\]/);
});

test('a listed menu says that it opens, and how', () => {
  const text = renderObservationForModel(observation());
  // Without this a model reads a list of menu names as a list of things that
  // cannot be used, and the round trip that would open one is never spent.
  assert.match(text, /menu_bar=2/);
  assert.match(text, /not_opened/);
  assert.match(text, /menu="<title>"/);
});

test('an opened menu names itself rather than repeating the offer', () => {
  const text = renderObservationForModel(
    observation({ menu: { opened: '文件' } } as Partial<CuObservation>),
  );
  assert.match(text, /opened="文件"/);
  assert.doesNotMatch(text, /not_opened/);
});

test('a disabled command is explained once, not left to be retried', () => {
  const text = renderObservationForModel(observation());
  // Measured: TextEdit in the background has 52 of 250 menu items enabled and
  // 168 in front, and the 116 that change are 存储, 导出为PDF…, 页面设置… —
  // the commands a task is usually about. `AXPress` on one returns success and
  // does nothing, so a model not told this reads the refusal as its own error.
  assert.match(text, /needs its application in front/);
});

test('a menu with nothing disabled is not given the explanation', () => {
  const all = observation();
  const text = renderObservationForModel({
    ...all,
    elements: all.elements.filter((e) => e.enabled !== false),
  });
  assert.doesNotMatch(text, /needs its application in front/);
});

test('a menu cut short by the executor says so, and a menu merely unopened does not', () => {
  const cut = renderObservationForModel(
    observation({ menu: { opened: '文件', truncated: true } } as Partial<CuObservation>),
  );
  assert.match(cut, /truncated=true\(this menu was cut short/);
  // Stopping at the bar is the shape the host asked for. Reporting it as a
  // truncation would present the host's own request to the model as a limit of
  // the machine, and send it looking for a command that was never below.
  assert.doesNotMatch(renderObservationForModel(observation()), /truncated=true\(this menu/);
});

test('an observation with no menu bar renders as it did before menus existed', () => {
  const base = observation();
  const text = renderObservationForModel({
    ...base,
    elements: base.elements.slice(0, 3),
  });
  assert.doesNotMatch(text, /menu_bar=/);
  assert.match(text, /elements=3$/m);
});
