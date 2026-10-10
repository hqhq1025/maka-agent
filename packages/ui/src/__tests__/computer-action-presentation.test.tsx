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
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { ComputerUseActivity } from '@maka/core/computer-use';
import type { StoredMessage } from '@maka/core/session';
import { ToolTrow } from '../tool-activity.js';
import { LocaleProvider } from '../locale-context.js';
import { materializeTools, materializeTurns, overlayLiveTurn, type ToolActivityItem } from '../materialize.js';
import { applyLiveTurnEvent } from './live-turn-zh.js';
import { computerActionTarget } from '../tool-activity/computer-action-label.js';
import { computerActionState } from '../tool-activity/computer-action-row.js';

const activity: ComputerUseActivity = {
  toolCallId: 'double-1', action: 'double_click_element',
  target: { observationId: 'before-action', appId: 'fixture', windowTitle: 'Maka Cua Spike Counter',
    elementId: 'before:2', role: 'push_button', label: 'Double-click target' },
  outcome: { execution: 'attempted', ok: true, effect: 'unverifiable', verified: false },
};
const args = { action: 'double_click_element', app: '3294631', observation_id: 'before-action', element_id: 'before:2' };
const messages: StoredMessage[] = [
  { type: 'tool_call', id: 'double-1', toolName: 'mcp__desktop_computer_use__computer', turnId: 'turn', ts: 1, args },
  { type: 'tool_result', id: 'result-1', toolUseId: 'double-1', turnId: 'turn', ts: 2,
    isError: false, durationMs: 1000, content: { kind: 'text', text: 'native diagnostic verified=false', computerUse: activity } },
];

function documentFor(item: ToolActivityItem) {
  return parseHTML(renderToStaticMarkup(createElement(LocaleProvider, { locale: 'zh-CN',
    children: createElement(ToolTrow, { items: [item] }),
  }))).document;
}

it('renders only the observed action after recovery and keeps diagnostics behind the log disclosure', () => {
  const [item] = materializeTools(JSON.parse(JSON.stringify(messages)));
  assert.ok(item);
  const document = documentFor(item);
  const row = document.querySelector('.maka-computer-action');
  assert.equal(row?.getAttribute('data-state'), 'unconfirmed');
  const heading = row?.querySelector('summary')?.textContent ?? '';
  assert.match(heading, /双击.*Double-click target/);
  assert.equal(heading, '双击 「Double-click target」');
  assert.doesNotMatch(heading, /3294631|1\.0s|1000|verified|before:2|效果未确认/);
  assert.equal(row?.hasAttribute('open'), false);
  const diagnostics = row?.querySelector('.maka-computer-action-log');
  assert.ok(diagnostics);
  assert.match(diagnostics?.textContent ?? '', /native diagnostic verified=false/);
  assert.match(diagnostics?.textContent ?? '', /耗时：/);
  assert.equal(row?.querySelector('.maka-computer-action-result,.maka-computer-action-context') ?? null, null);
  assert.equal(row?.querySelector('.lucide-circle-check-big,.lucide-circle-check') ?? null, null);
});

it('uses terminal live metadata without fabricating a result and preserves it through durable hydration', () => {
  let live = applyLiveTurnEvent(undefined, {
    type: 'tool_start', id: 'start', turnId: 'turn', ts: 1,
    toolUseId: 'double-1', toolName: 'mcp__desktop_computer_use__computer', args,
  });
  live = applyLiveTurnEvent(live, {
    type: 'tool_result', id: 'result', turnId: 'turn', ts: 2,
    toolUseId: 'double-1', isError: false, content: { kind: 'text', text: '' },
    contentOmitted: true, computerUse: activity,
  });
  const streamed = live.steps[0]?.tools[0];
  assert.ok(streamed);
  assert.equal(streamed.result, undefined);
  assert.equal(computerActionTarget(streamed, 'zh-CN'), '「Double-click target」');
  assert.equal(computerActionState(streamed), 'unconfirmed');
  const hydrated = overlayLiveTurn(materializeTurns(messages, 'zh-CN'), live, 'zh-CN')
    .flatMap((turn) => turn.tools).find((tool) => tool.toolUseId === 'double-1');
  assert.ok(hydrated);
  assert.deepEqual(hydrated.result, messages[1]?.type === 'tool_result' ? messages[1].content : undefined);
  assert.equal(computerActionTarget(hydrated, 'zh-CN'), computerActionTarget(streamed, 'zh-CN'));
  assert.equal(computerActionState(hydrated), computerActionState(streamed));
});

it('distinguishes a foreground grant from the input that has not been sent', () => {
  const [base] = materializeTools(messages);
  assert.ok(base);
  const item: ToolActivityItem = { ...base, status: 'errored', computerUse: {
    toolCallId: 'double-1', action: 'double_click_element',
    outcome: { execution: 'not_started', ok: false, error: 'reobserve_required', reason: 'foreground_authorized_reobserve' },
  } };
  const document = documentFor(item);
  const row = document.querySelector('.maka-computer-action');
  assert.equal(row?.getAttribute('data-state'), 'authorized');
  assert.equal(row?.querySelector('summary')?.textContent, '前台操作已获准');
  assert.doesNotMatch(row?.querySelector('summary')?.textContent ?? '', /双击|3294631|尚未操作/);
});

it('does not infer a control from model fields, another call, or a suspected no-op', () => {
  const item: ToolActivityItem = {
    toolUseId: 'different-call', toolName: 'computer', status: 'completed',
    args: { ...args, label: 'Invented control', element_identity: { label: 'Invented identity' } },
    computerUse: activity,
  };
  assert.equal(computerActionTarget(item, 'zh-CN'), undefined);
  assert.equal(computerActionState(item), 'unrecorded');
  const markup = documentFor(item).querySelector('summary')?.textContent ?? '';
  assert.doesNotMatch(markup, /Invented|Double-click target|3294631/);
  const suspicious = { ...item, toolUseId: activity.toolCallId, computerUse: {
    ...activity, outcome: { execution: 'attempted' as const, ok: true, effect: 'suspected_noop' as const },
  } };
  assert.equal(computerActionState(suspicious), 'noChange');
  assert.doesNotMatch(documentFor(suspicious).querySelector('summary')?.textContent ?? '', /已确认/);
});

it('distinguishes a proven input refusal from an unknown delivery with unverified effect', () => {
  const [base] = materializeTools(messages);
  assert.ok(base);
  const refused: ToolActivityItem = { ...base, status: 'errored', computerUse: {
    ...activity,
    outcome: { execution: 'not_started', ok: false, error: 'unsupported_action', effect: 'unverifiable' },
  } };
  assert.equal(computerActionState(refused), 'notStarted');
  assert.equal(documentFor(refused).querySelector('.maka-computer-action')?.getAttribute('data-state'), 'notStarted');
  const unknown: ToolActivityItem = { ...refused, computerUse: {
    ...refused.computerUse!, outcome: { ...refused.computerUse!.outcome, error: 'outcome_unknown' },
  } };
  assert.equal(computerActionState(unknown), 'unconfirmed');
});
