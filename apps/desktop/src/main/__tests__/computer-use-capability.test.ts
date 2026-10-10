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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createDefaultSettings } from '@maka/core/settings';
import { BOT_PROVIDERS } from '@maka/core/bot-chat-settings';

test('Computer Use readiness requires only the permissions needed for semantic control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-capability-platform-'));
  try {
    const output = join(directory, 'snapshot.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../capability-snapshot.js', import.meta.url))],
      outfile: output, bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'electron-read-only-stub', setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Notification = { isSupported: () => false }; export const systemPreferences = { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => "denied" };' }));
      } }],
    });
    const { buildPermissionSnapshot, buildCapabilitySnapshotCollection } = await import(pathToFileURL(output).href);
    for (const platform of ['win32', 'linux']) {
      const permissions = buildPermissionSnapshot(100, platform);
      const collection = buildCapabilitySnapshotCollection({ settings: createDefaultSettings(), permissions, botStatuses: Object.fromEntries(BOT_PROVIDERS.map(p => [p, { readiness: 'not_configured' }])), computerUse: { backendId: 'cua-driver', health: { state: 'healthy', reason: 'cu_executor_ready' } }, now: 100 });
      const cu = collection.capabilities.find((cap: { id: string }) => cap.id === 'computer_use');
      assert.equal(cu.readiness, 'enabled');
      assert.deepEqual(cu.osPermissions, []);
    }
    const permissions = buildPermissionSnapshot(100, 'darwin');
    const collect = () => buildCapabilitySnapshotCollection({ settings: createDefaultSettings(), permissions, botStatuses: Object.fromEntries(BOT_PROVIDERS.map(p => [p, { readiness: 'not_configured' }])), computerUse: { backendId: 'cua-driver', health: { state: 'healthy', reason: 'cu_executor_ready' } }, now: 100 }).capabilities.find((cap: { id: string }) => cap.id === 'computer_use');
    const axOnly = collect();
    assert.equal(axOnly.readiness, 'enabled', 'denied capture must not block AX-only operation');
    assert.deepEqual(axOnly.osPermissions, [
      { id: 'accessibility', required: true, status: 'granted' },
      { id: 'screen_recording', required: false, status: 'denied' },
    ], 'the capture permission remains visible as an optional capability');
    permissions.permissions.accessibility.status = 'not_determined';
    assert.equal(collect().readiness, 'not_configured', 'semantic actions still need Accessibility');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
