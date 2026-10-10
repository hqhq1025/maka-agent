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
import { z } from 'zod';
import { createDefaultSettings, mergeSettings, type UpdateAppSettingsInput } from '@maka/core/settings';
import { clientOwnedSettingsPatch, hasRuntimeHostSettingsPatch, projectClientOwnedSettings } from '../../shared/settings-ownership.js';
import { registerClientSettingsIpc } from '../client-settings-ipc-main.js';
import { buildClientSettingsTools } from '../client-settings-tools.js';

test('persists foreground policy on the executing Desktop independently of the selected Host', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let local = createDefaultSettings();
  let applied = '';
  registerClientSettingsIpc({
    ipcMain: {
      handle(channel, listener) { handlers.set(channel, listener as (...args: unknown[]) => unknown); },
    },
    settingsStore: {
      get: async () => local,
      update: async (patch: UpdateAppSettingsInput) => {
        local = mergeSettings(local, patch);
        return local;
      },
    } as never,
    apply: async (settings) => { applied = settings.computerUse.foregroundPolicy; },
  });

  const patch = { computerUse: { foregroundPolicy: 'never' as const } };
  assert.deepEqual(clientOwnedSettingsPatch(patch), patch);
  assert.equal(hasRuntimeHostSettingsPatch(patch), false);
  await handlers.get('settings:client:update')?.({}, patch);
  assert.equal(local.computerUse.foregroundPolicy, 'never');
  assert.equal(applied, 'never');

  const remote = mergeSettings(createDefaultSettings(), { computerUse: { foregroundPolicy: 'allow' } });
  assert.equal(projectClientOwnedSettings(remote, local).computerUse.foregroundPolicy, 'never');
});

test('the model settings tool cannot change or expose foreground authority', async () => {
  let updates = 0;
  const tools = buildClientSettingsTools({
    read: async () => createDefaultSettings(),
    update: async () => { updates += 1; return createDefaultSettings(); },
    confirm: async () => { assert.fail('Forged foreground policy must not reach confirmation'); },
  });
  const read = tools.find((tool) => tool.name === 'MakaClientSettingsGet')!;
  const update = tools.find((tool) => tool.name === 'MakaClientSettingsUpdate')!;
  assert.ok(update.parameters instanceof z.ZodType);
  assert.equal(update.parameters.safeParse({ computerUse: { foregroundPolicy: 'allow' } }).success, false);
  assert.equal(update.parameters.safeParse({ appearance: { theme: 'dark' }, computerUse: { foregroundPolicy: 'allow' } }).success, false);
  const snapshot = await read.impl({}, {} as never);
  assert.equal(Object.hasOwn(snapshot as object, 'computerUse'), false);
  assert.equal(updates, 0);
});
