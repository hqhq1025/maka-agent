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
import { test } from 'node:test';
import {
  clientCapabilityScopeIdentity,
  decodeClientCapabilitySessionGrant,
} from '../client-capability-grant.js';

test('MCP grants preserve exact Session/provider/contract/tool authority without changing Desktop grants', () => {
  for (const capability of ['mcp', 'desktop_mcp']) {
    const record = {
      version: 1,
      sessionId: 'session',
      providerId: 'provider',
      contractId: 'contract',
      serverId: 'server',
      toolName: 'tool',
      capability,
      scope: { kind: 'mcp_tool', serverId: 'server', toolName: 'tool' },
      grantedAt: 1,
    };
    assert.deepEqual(decodeClientCapabilitySessionGrant(record), record);
    assert.throws(
      () => decodeClientCapabilitySessionGrant({ ...record, scope: { kind: 'capability' } }),
      /scope does not match/,
    );
    assert.throws(
      () =>
        decodeClientCapabilitySessionGrant({
          ...record,
          scope: { kind: 'browser_origin', origin: 'https://example.com' },
        }),
      /scope does not match/,
    );
  }
});

const computerUseGrant = {
  version: 1,
  sessionId: 'session',
  providerId: 'desktop',
  contractId: 'contract',
  serverId: 'desktop_computer_use',
  toolName: 'computer',
  capability: 'computer_use',
  scope: { kind: 'computer_use_foreground', authorityEpoch: 'a'.repeat(64) },
  grantedAt: 1,
};

test('foreground grants preserve exact task authority across serialization', () => {
  const grant = decodeClientCapabilitySessionGrant(JSON.parse(JSON.stringify(computerUseGrant)));
  assert.deepEqual(grant, computerUseGrant);
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.scope), true);
  assert.deepEqual(
    decodeClientCapabilitySessionGrant({ ...computerUseGrant, scope: { kind: 'capability' } })
      .scope,
    { kind: 'capability' },
  );
});

test('foreground grant scope rejects malformed or extra authority fields', () => {
  for (const scope of [
    { kind: 'computer_use_foreground' },
    { kind: 'computer_use_foreground', authorityEpoch: null },
    { kind: 'computer_use_foreground', authorityEpoch: 1 },
    { kind: 'computer_use_foreground', authorityEpoch: '' },
    { kind: 'computer_use_foreground', authorityEpoch: 'a'.repeat(129) },
    { kind: 'computer_use_foreground', authorityEpoch: 'epoch\0other' },
    { kind: 'computer_use_foreground', authorityEpoch: 'epoch/other' },
    { kind: 'computer_use_foreground', authorityEpoch: 'epoch', origin: 'https://example.com' },
  ]) {
    assert.throws(() => decodeClientCapabilitySessionGrant({ ...computerUseGrant, scope }));
  }
  for (const authorityEpoch of ['a', 'epoch_2-Ab', 'a'.repeat(128)]) {
    assert.deepEqual(
      decodeClientCapabilitySessionGrant({
        ...computerUseGrant,
        scope: { kind: 'computer_use_foreground', authorityEpoch },
      }).scope,
      { kind: 'computer_use_foreground', authorityEpoch },
    );
  }
});

test('foreground authority cannot grant another capability', () => {
  for (const capability of ['browser', 'desktop_mcp', 'mcp']) {
    assert.throws(
      () => decodeClientCapabilitySessionGrant({ ...computerUseGrant, capability }),
      /scope does not match/,
    );
  }
});

test('foreground scope identity separates capability and each authority epoch', () => {
  const foreground = clientCapabilityScopeIdentity({
    kind: 'computer_use_foreground',
    authorityEpoch: 'epoch-a',
  });
  assert.notEqual(foreground, clientCapabilityScopeIdentity({ kind: 'capability' }));
  assert.notEqual(
    foreground,
    clientCapabilityScopeIdentity({ kind: 'computer_use_foreground', authorityEpoch: 'epoch-b' }),
  );
  assert.equal(
    foreground,
    clientCapabilityScopeIdentity({ kind: 'computer_use_foreground', authorityEpoch: 'epoch-a' }),
  );
});
