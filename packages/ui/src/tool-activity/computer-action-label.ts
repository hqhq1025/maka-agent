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

/**
 * Compact activity wording comes from the submitted action, never model-written
 * narration. Observed names come from the Runtime's snapshot for this call.
 * Legacy and running calls without that snapshot retain generic action labels.
 */

import { type ComputerUseActivity, type ComputerUseModelCallArgs } from '@maka/core/computer-use';

import { type UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { type ComputerActionKind, getToolActivityCopy } from './copy.js';
import { redactSecrets } from '../redact.js';

export function computerActivity(item: Partial<Pick<ToolActivityItem, 'toolUseId' | 'computerUse' | 'result'>>): ComputerUseActivity | undefined {
  const activity = item.computerUse ?? (item.result?.kind === 'text' ? item.result.computerUse : undefined);
  return activity?.toolCallId === item.toolUseId ? activity : undefined;
}

/** True for a row produced by the Computer Use tool. */
export function isComputerTool(item: Pick<ToolActivityItem, 'toolName' | 'activityKind'>): boolean {
  return (
    item.toolName === 'computer' ||
    item.toolName.endsWith('__computer') ||
    // Persisted calls keep their original tool identity after the rename.
    item.toolName === 'maka_computer' ||
    item.toolName.endsWith('__maka_computer') ||
    item.activityKind === 'computer'
  );
}

/**
 * The row label for a Computer Use call, or `undefined` for any other tool.
 *
 * A Computer Use call always gets a label — an unknown or missing `action`
 * still resolves to the generic "操作电脑", never to the tool's display name.
 */
export function computerActionLabel(
  item: Pick<ToolActivityItem, 'toolName' | 'activityKind' | 'args' | 'argsPreview'>
    & Partial<Pick<ToolActivityItem, 'status' | 'computerUse' | 'result' | 'toolUseId'>>,
  locale: UiLocale,
): string | undefined {
  if (!isComputerTool(item)) return undefined;
  const copy = getToolActivityCopy(locale).computer;
  const activity = computerActivity(item);
  if (activity?.outcome.reason === 'foreground_authorized_reobserve') return copy.foregroundAuthorized;
  const args = asRecord(item.args ?? item.argsPreview);
  const action = copy.actions[actionKind(activity ? { action: activity.action } : args ?? {})];
  return item.status === 'running' ? action.running : action.label;
}

export function computerActionTarget(
  item: ToolActivityItem,
  locale: UiLocale,
): string | undefined {
  if (!isComputerTool(item)) return undefined;
  const copy = getToolActivityCopy(locale).computer;
  const target = computerActivity(item)?.target;
  const label = displayable(target?.label);
  if (label) return copy.targetName(label);
  const observedApp = displayable(target?.windowTitle) ?? displayable(target?.appName);
  if (observedApp) return copy.targetName(observedApp);
  const args = asRecord(item.args ?? item.argsPreview);
  if (!args) return undefined;
  const app = displayable(str(args, 'app'));
  return app === undefined || /^\d+$/.test(app) ? undefined : copy.targetName(app);
}

export function computerRunningLabel(
  items: readonly ToolActivityItem[],
  locale: UiLocale,
): string | undefined {
  let active: ToolActivityItem | undefined;
  for (const item of items) {
    if (!isComputerTool(item)) continue;
    if (item.status === 'running') active = item;
  }
  if (!active) return undefined;
  const target = computerActionTarget(active, locale);
  const copy = getToolActivityCopy(locale).computer;
  const args = asRecord(active.args ?? active.argsPreview);
  const actionName = str(args ?? {}, 'action');
  if (actionName === 'element_sequence' && active.progress) {
    return copy.runningSequence(active.progress.current, active.progress.total, target);
  }
  const action = computerActionLabel(active, locale) ?? copy.actions.operate.running;
  return target ? `${action} · ${target}` : action;
}

/**
 * The keys the projection declares by name, and the only ones read below.
 *
 * Not `keyof ComputerUseModelCallArgs`: that interface carries an index
 * signature for every other argument the model sent, so `keyof` widens to
 * `string | number` and a stale camelCase name would type check again.
 * Filtering the index signature back out leaves only names the projection
 * spells out, so renaming one there is a build error here rather than a row
 * that quietly loses its target.
 */
type DeclaredArg<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: unknown;
};
type SummaryKey = DeclaredArg<ComputerUseModelCallArgs>;

function actionKind(args: Record<string, unknown>): ComputerActionKind {
  const action = str(args, 'action');
  switch (action) {
    case 'list_apps':
    case 'observe':
    case 'zoom':
    case 'cursor_position':
      return 'inspect';
    case 'launch_app':
      return 'open';
    case 'screenshot':
      return 'capture';
    case 'click_element':
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      return 'click';
    case 'double_click_element':
    case 'double_click':
      return 'doubleClick';
    case 'set_value':
    case 'type':
      return 'fill';
    case 'select_text':
      return 'select';
    case 'scroll_element':
    case 'scroll':
      return 'scroll';
    case 'window_action':
      return 'window';
    case 'press_key':
    case 'key':
    case 'hold_key':
      return 'key';
    case 'wait':
      return 'wait';
    // Readable labels for older transcripts do not enable coordinate input.
    case 'mouse_move':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'left_click_drag':
      return 'pointer';
    default:
      return 'operate';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(record: Record<string, unknown>, key: SummaryKey): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Keep an app name short enough to stay on one row. */
const APP_CAP = 80;

/**
 * The projection already redacts and bounds `app` to 256 characters; a row is
 * narrower than that, so cap it again for layout rather than for safety.
 */
function displayable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = redactSecrets(value).replace(/\s+/g, ' ').trim();
  if (safe.length === 0) return undefined;
  return safe.length > APP_CAP ? `${safe.slice(0, APP_CAP)}…` : safe;
}
