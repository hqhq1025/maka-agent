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
import { mkdir, writeFile } from 'node:fs/promises';

export async function smoke() {
  console.error('spike: importing SDK');
  // Dynamic import deliberately measures the real native loading boundary.
  const { CuaDriver, ListAppsInput } = await import('@trycua/cua-driver');
  const report = {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    },
    checks: [],
  };
  const driver = CuaDriver.create(undefined);
  console.error('spike: runtime created');
  try {
    report.metadata = await driver.metadata();
    console.error('spike: metadata received');
    assert.equal(report.metadata.driverVersion, '0.34.0');
    report.permissions = await driver.callTool(
      'check_permissions',
      JSON.stringify({ prompt: false }),
    );
    assert.equal(report.permissions.isError, false);
    report.identity = await driver.callTool(
      'health_report',
      JSON.stringify({ include: ['bundle_identity'] }),
    );
    const apps = await driver.listApps(ListAppsInput.new({}));
    // Persist counts only: unrelated application/window contents are not evidence for this spike.
    report.apps = { count: apps.apps.length };
    report.checks.push('native version', 'read-only permissions', 'host identity', 'list apps');
  } finally {
    await driver.shutdown();
    driver.uniffiDestroy();
    report.checks.push('shutdown and native handle destruction');
  }
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`./results/${process.versions.electron ? 'electron' : 'node'}.json`, import.meta.url),
    JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
  );
  console.log(
    JSON.stringify({
      runtime: report.runtime,
      metadata: report.metadata,
      checks: report.checks,
      permissions: JSON.parse(report.permissions.structuredJson),
      apps: report.apps,
    }),
  );
  return report;
}

if (!process.versions.electron) await smoke();
