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

import type { ReactNode } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { AlertCircle, Ban, CheckCircle2, ChevronRight, ICON_SIZE, Info, Minus, MousePointer2 } from '../icons.js';
import { RunningIndicator } from '../running-indicator.js';
import { computerActivity, computerActionLabel, computerActionTarget } from './computer-action-label.js';
import { getToolActivityCopy, type ComputerActionState } from './copy.js';
import { formatDuration } from './preview-utils.js';

const READ_ACTIONS = new Set(['observe', 'screenshot', 'list_apps', 'zoom', 'cursor_position', 'wait']);

/** Delivery completion alone does not confirm a native action's effect. */
export function computerActionState(item: ToolActivityItem): ComputerActionState {
  const activity = computerActivity(item);
  if (activity?.outcome.reason === 'foreground_authorized_reobserve') return 'authorized';
  if (item.status === 'running') return 'running';
  const outcome = activity?.outcome;
  if (outcome?.error === 'outcome_unknown') return 'unconfirmed';
  if (item.status === 'interrupted' || outcome?.error === 'user_stopped') return 'stopped';
  if (outcome?.execution === 'not_started') return 'notStarted';
  if (outcome?.effect === 'unverifiable') return 'unconfirmed';
  if (outcome?.effect === 'suspected_noop') return 'noChange';
  if (item.status === 'errored' || outcome?.ok === false) return 'failed';
  if (!activity) return 'unrecorded';
  if (outcome?.effect === 'confirmed' || outcome?.verified === true || READ_ACTIONS.has(activity.action)) return 'confirmed';
  return 'unconfirmed';
}

const STATE_ICON = {
  confirmed: CheckCircle2,
  unconfirmed: MousePointer2,
  notStarted: Minus,
  failed: AlertCircle,
  noChange: Minus,
  unrecorded: MousePointer2,
  authorized: Info,
  stopped: Ban,
} as const;

/** Computer results need an uncertainty state that the generic tool row does not expose. */
export function ComputerActionRow(props: {
  item: ToolActivityItem;
  locale: UiLocale;
  activityObserved: boolean;
  errorMessage?: string;
  children: ReactNode;
}) {
  const { item, locale } = props;
  const state = computerActionState(item);
  const copy = getToolActivityCopy(locale).computer;
  const target = computerActionTarget(item, locale);
  const Icon = state === 'running' ? Info : STATE_ICON[state];
  return <details className="maka-computer-action" data-state={state} data-tool-use-id={item.toolUseId}>
    <summary className="maka-computer-action-heading">
      <span className="maka-computer-action-signal" role="img"
        aria-label={state === 'failed' && props.errorMessage ? props.errorMessage : copy.states[state]}
        title={state === 'failed' ? props.errorMessage : undefined}>
        {state === 'running' && props.activityObserved
          ? <RunningIndicator label={copy.states[state]} />
          : <Icon size={ICON_SIZE.meta} aria-hidden="true" />}
      </span>
      <span className="maka-computer-action-name">{computerActionLabel(item, locale)}{target ? <> {target}</> : null}</span>
      {state === 'running' && item.progress ? <span className="maka-computer-action-status">{item.progress.current}/{item.progress.total}</span> : null}
      <span className="maka-computer-action-chevron" title={copy.diagnostics}><ChevronRight size={ICON_SIZE.meta} aria-hidden="true" /></span>
    </summary>
    <div className="maka-computer-action-body">{props.children}</div>
  </details>;
}

export function ComputerActionLog(props: { item: ToolActivityItem; locale: UiLocale; children: ReactNode }) {
  const copy = getToolActivityCopy(props.locale).computer;
  const duration = formatDuration(props.item.durationMs);
  return <div className="maka-computer-action-log">
    <p className="maka-computer-action-log-heading">{copy.diagnostics}{duration ? ` · ${copy.duration(duration)}` : ''}</p>
    {props.children}
  </div>;
}
