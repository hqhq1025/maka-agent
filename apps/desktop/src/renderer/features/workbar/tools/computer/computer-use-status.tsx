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

import { Button } from '@astryxdesign/core';
import { useUiLocale } from '@maka/ui';
import { Monitor, ICON_SIZE } from '@maka/ui/icons';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComputerUsePresentation } from '../../../../../shared/computer-use-presentation.js';
import { computerUseCopy } from './computer-use-copy.js';
import { useComputerUsePresentation } from './use-computer-use-presentation.js';

/** A small application entry opens the Workbar without starting a capture. */
export function ComputerUseConversationStatus(props: {
  sessionId: string | undefined;
  onOpen(): void;
}) {
  const { presentation } = useComputerUsePresentation(props.sessionId);
  return <ComputerUseStatusView presentation={presentation} locale={useUiLocale()} onOpen={props.onOpen} />;
}

export function ComputerUseStatusView(props: {
  presentation: ComputerUsePresentation | null;
  locale: UiLocale;
  onOpen(): void;
}) {
  const state = props.presentation;
  if (!state) return null;
  const copy = computerUseCopy(props.locale);
  const app = state.appName || copy.computer;
  return <div className="maka-computer-conversation-status" title={`${copy.open} · ${app}`}>
    <Button variant="ghost" className="maka-computer-activity-entry"
      label={`${copy.open} · ${app}`}
      onClick={props.onOpen}>
      <span className="maka-computer-activity-icon" aria-hidden="true">
        {state.appIconDataUrl ? <img src={state.appIconDataUrl} alt="" width={16} height={16} draggable={false} />
          : <Monitor size={ICON_SIZE.meta} />}
      </span>
    </Button>
  </div>;
}
