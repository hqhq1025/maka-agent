/**
 * A readable row label for one `maka_computer` call, derived from the call's
 * own arguments.
 *
 * Every other tool's row reads as an action because its display name happens to
 * be a verb phrase ("加载工具组"). Computer Use's display name is a noun —
 * "Maka Computer" — so a turn that observed a window, clicked a button, and
 * observed again rendered three identical rows and the reader could not tell
 * which call did what.
 *
 * The label is derived, never declared: the model is not given an `intent`
 * field to write. Every word the model sees is owned by the runtime, and a free
 * text field would be one more place it can be wrong (and more tokens on every
 * call). The arguments already carry the action, the target app/window, the
 * element id, the typed value, the key, and — for `element_sequence` — the
 * control labels themselves.
 *
 * What is NOT available here: an element's human label. `element_id` is an
 * index into one observation, and the observation the UI can see is the
 * persisted projection (`persistedObservationText` in
 * `packages/runtime/src/computer-use-tools.ts`), which is a JSON header of
 * observation_id/app/pid/window_id/element_count — no element rows at all. The
 * labelled tree only ever exists in `modelText`, which is not persisted and
 * never reaches the renderer. So an element action falls back to the id
 * ("点击元素 e12"), which still says what happened and to what, rather than
 * back to the tool name.
 */

import type { UiLocale } from '@maka/core';
import type { ToolActivityItem } from '../materialize.js';
import { redactSecrets } from '../redact.js';
import { getToolActivityCopy, type ToolActivityCopy } from './copy.js';

/** Keep a quoted argument short enough to stay one row. */
const VALUE_CAP = 32;
/** How many `element_sequence` step labels are spelled out before the ellipsis. */
const SEQUENCE_LABEL_CAP = 3;

/** True for a row produced by the Computer Use tool. */
export function isComputerTool(item: ToolActivityItem): boolean {
  return item.toolName === 'maka_computer' || item.activityKind === 'computer';
}

/**
 * The row label for a Computer Use call, or `undefined` for any other tool.
 *
 * A Computer Use call always gets a label — an unknown or missing `action`
 * still resolves to the generic "操作电脑", never to the tool's display name.
 */
export function computerActionLabel(
  item: ToolActivityItem,
  locale: UiLocale,
): string | undefined {
  if (!isComputerTool(item)) return undefined;
  const copy = getToolActivityCopy(locale).computer;
  const args = asRecord(item.args);
  if (!args) return copy.fallback;
  return describeAction(args, copy) ?? copy.fallback;
}

function describeAction(
  args: Record<string, unknown>,
  copy: ToolActivityCopy['computer'],
): string | undefined {
  const action = str(args, 'action');
  const app = quotable(str(args, 'app'));
  const windowId = int(args, 'window_id');
  const elementId = str(args, 'element_id');
  const element = elementId ? copy.element(elementId) : copy.elementUnknown;
  const value = quotable(str(args, 'value'));
  const text = quotable(str(args, 'text'));
  const point = coordinate(args, 'coordinate');
  const direction = str(args, 'scroll_direction');
  const localizedDirection =
    direction && direction in copy.direction
      ? copy.direction[direction as keyof ToolActivityCopy['computer']['direction']]
      : undefined;
  const seconds = num(args, 'duration');

  switch (action) {
    case 'list_apps':
      return copy.listApps;
    case 'launch_app':
      return copy.launchApp(app);
    case 'observe':
      return app !== undefined
        ? copy.observeApp(app)
        : windowId !== undefined
          ? copy.observeWindow(windowId)
          : copy.observe;
    case 'screenshot':
      return app !== undefined
        ? copy.screenshotApp(app)
        : windowId !== undefined
          ? copy.screenshotWindow(windowId)
          : copy.screenshot;
    case 'click_element':
      return copy.clickElement(element);
    case 'set_value':
      return copy.setValue(value, element);
    case 'select_text':
      return copy.selectText(text, element);
    case 'secondary_action':
      return copy.secondaryAction(text, element);
    case 'scroll_element':
      return copy.scrollElement(localizedDirection, element);
    case 'element_sequence':
      return sequenceLabel(args, copy);
    case 'press_key':
    case 'key':
      return copy.pressKey(text);
    case 'type':
      return copy.type(text);
    case 'hold_key':
      return copy.holdKey(text, seconds);
    case 'wait':
      return copy.wait(seconds);
    case 'zoom':
      return copy.zoom;
    case 'cursor_position':
      return copy.cursorPosition;
    case 'scroll':
      return copy.scroll(localizedDirection);
    case 'mouse_move':
      return copy.pointer.move(point);
    case 'left_click':
      return copy.pointer.left(point);
    case 'right_click':
      return copy.pointer.right(point);
    case 'middle_click':
      return copy.pointer.middle(point);
    case 'double_click':
      return copy.pointer.double(point);
    case 'triple_click':
      return copy.pointer.triple(point);
    case 'left_mouse_down':
      return copy.pointer.down(point);
    case 'left_mouse_up':
      return copy.pointer.up(point);
    case 'left_click_drag':
      return copy.pointer.drag(point);
    default:
      return undefined;
  }
}

/**
 * `element_sequence` is the one action whose arguments carry real control
 * labels: its steps name controls by the label they show, precisely so the
 * labels survive the re-observation between steps. Spell the first few out.
 */
function sequenceLabel(
  args: Record<string, unknown>,
  copy: ToolActivityCopy['computer'],
): string {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const labels = steps
    .map((step) => quotable(str(asRecord(step) ?? {}, 'label')))
    .filter((label): label is string => label !== undefined);
  if (labels.length === 0) return copy.sequenceCount(steps.length);
  const shown = labels.slice(0, SEQUENCE_LABEL_CAP);
  return copy.sequence(shown, labels.length > shown.length);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function int(record: Record<string, unknown>, key: string): number | undefined {
  const value = num(record, key);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

/** `[x, y]` as the wire schema declares it, rendered as `(x, y)`. */
function coordinate(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [x, y] = value;
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return `(${x}, ${y})`;
}

/**
 * A model-supplied string on its way into a always-visible row: redacted (a
 * `set_value` can be a password), collapsed to one line, and capped.
 */
function quotable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = redactSecrets(value.replace(/\s+/g, ' ').trim());
  if (safe.length === 0) return undefined;
  return safe.length > VALUE_CAP ? `${safe.slice(0, VALUE_CAP)}…` : safe;
}
