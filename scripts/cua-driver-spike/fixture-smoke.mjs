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
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import {
  CuaDriver,
  ListAppsInput,
  ListWindowsInput,
  GetWindowStateInput,
  ClickInput,
  ClickPosition,
  ActionTarget,
  InputDeliveryMode,
  ActionDeliveryMode,
  ActionEffect,
} from '@trycua/cua-driver';

export async function fixtureSmoke() {
  const child = spawn(new URL('./results/Fixture', import.meta.url).pathname, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const received = [];
  lines.on('line', (line) => received.push(line));
  const waitFor = async (predicate) => {
    const signal = AbortSignal.timeout(10000);
    while (!received.some(predicate)) await once(lines, 'line', { signal });
    return received.find(predicate);
  };
  const report = {
    version: '0.34.0',
    requestedDelivery: 'background',
    runtime: process.versions.electron ? `Electron ${process.versions.electron}` : 'Node',
  };
  let driver;
  try {
    await waitFor((line) => line.startsWith('READY '));
    driver = CuaDriver.create(undefined);
    const windows = await driver.listWindows(
      ListWindowsInput.new({ pid: child.pid, onScreenOnly: true }),
    );
    report.windows = windows;
    const matches = windows.windows.filter((w) => w.title === 'Maka Cua Spike Counter');
    assert.equal(matches.length, 1);
    const windowId = matches[0].windowId;
    const capture = GetWindowStateInput.new({
      pid: child.pid,
      windowId,
      includeScreenshot: false,
      includeAccessibilityTree: true,
    });
    const before = await driver.getWindowState(capture);
    report.before = before;
    assert.ok(!before.degraded && !before.truncated, 'usable fresh snapshot required');
    const buttons = before.elements?.filter((e) => e.label === 'Increment') ?? [];
    assert.equal(buttons.length, 1, 'one exact semantic target');
    assert.ok(buttons[0].elementToken);
    child.stdin.write('read\n');
    await waitFor((line) => line === 'READ 0');
    const activeBefore = (await driver.listApps(ListAppsInput.new({}))).apps
      .filter((a) => a.active)
      .map((a) => a.pid);
    report.action = await driver.click(
      ClickInput.new({
        target: ActionTarget.Window.new({ pid: child.pid, windowId }),
        position: ClickPosition.Element.new({ elementToken: buttons[0].elementToken }),
        deliveryMode: InputDeliveryMode.Background,
      }),
    );
    assert.notEqual(report.action.effect, ActionEffect.Refused);
    assert.equal(report.action.delivery?.mode, ActionDeliveryMode.Background);
    report.after = await driver.getWindowState(capture);
    assert.match(report.after.treeMarkdown ?? '', /AXStaticText = "1" \(Count\)/);
    const activeAfter = (await driver.listApps(ListAppsInput.new({}))).apps
      .filter((a) => a.active)
      .map((a) => a.pid);
    report.focus = {
      sameAtObservationBoundaries: JSON.stringify(activeBefore) === JSON.stringify(activeAfter),
      fixtureActiveBefore: activeBefore.includes(child.pid),
      fixtureActiveAfter: activeAfter.includes(child.pid),
    };
    child.stdin.write('read\n');
    await waitFor((line) => line === 'READ 1');
    report.independentReadback = { before: 0, after: 1 };
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    if (driver) {
      await driver.shutdown();
      driver.uniffiDestroy();
    }
    child.stdin.end('quit\n');
    await exited;
    report.fixtureExited = true;
    await mkdir(new URL('./results/', import.meta.url), { recursive: true });
    await writeFile(
      new URL('./results/fixture.json', import.meta.url),
      JSON.stringify(
        report,
        (_, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      ),
    );
    console.log(
      JSON.stringify({
        action: report.action,
        independentReadback: report.independentReadback,
        focus: report.focus,
        error: report.error,
        fixtureExited: report.fixtureExited,
      }),
    );
  }
}
