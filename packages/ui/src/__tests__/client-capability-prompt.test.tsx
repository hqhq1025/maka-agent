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
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClientCapabilityRequestEvent } from '@maka/core/events';
import { ClientCapabilityPrompt } from '../client-capability-prompt.js';
import { getConversationCopy } from '../conversation-copy.js';
import { LocaleProvider } from '../locale-context.js';

const request: ClientCapabilityRequestEvent = {
  type: 'client_capability_request',
  id: 'event', turnId: 'turn', ts: 0, requestId: 'request', toolUseId: 'call',
  capability: 'computer_use',
  scope: { kind: 'computer_use_foreground', authorityEpoch: 'policy-1' },
};

test('foreground consent names foreground access separately from general Computer Use in every locale', () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    const copy = getConversationCopy(locale).clientCapability;
    const render = (scope: ClientCapabilityRequestEvent['scope'], textResponseAvailable = false) => renderToStaticMarkup(
      <LocaleProvider locale={locale}>
        <ClientCapabilityPrompt request={{ ...request, scope }} onRespond={() => undefined} textResponseAvailable={textResponseAvailable} />
      </LocaleProvider>,
    );
    const foreground = render(request.scope);
    assert.ok(foreground.includes(copy.foregroundTitle));
    assert.ok(foreground.includes(copy.computerUseForeground));
    assert.ok(foreground.includes(copy.foregroundNotice));
    assert.ok(foreground.includes(copy.allowForeground));
    assert.ok(foreground.includes(copy.keepBackground));
    assert.ok(!foreground.includes(copy.textResponseHint), 'other hosts do not advertise an unavailable route');
    assert.ok(render(request.scope, true).includes(copy.textResponseHint));
    const general = render({ kind: 'capability' });
    assert.ok(general.includes(copy.computerUse));
    assert.ok(!general.includes(copy.foregroundTitle));
    assert.ok(!general.includes(copy.allowForeground));
  }
});
