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
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { selectComputerUseBackend } from './results/platform/selector.mjs';

assert.ok(['linux', 'win32'].includes(process.platform), 'Use electron-smoke.cjs --maka on macOS');
const doubleClick = process.argv.includes('--double-click');
const child =
  process.platform === 'linux'
    ? spawn('python3', [fileURLToPath(new URL('./linux-fixture.py', import.meta.url))], {
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    : spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Sta',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          fileURLToPath(new URL('./windows-fixture.ps1', import.meta.url)),
        ],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      );
// Keep launch/early-exit failures observable without an unhandled rejected promise.
const exited = new Promise((resolve) => {
  child.once('error', (error) => resolve({ error }));
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
child.stdin.on('error', () => {}); // The fixture may close stdin before cleanup sends quit.
const lines = createInterface({ input: child.stdout });
const seen = [];
lines.on('line', (line) => seen.push(line));
async function waitFor(prefix, since = 0) {
  const signal = AbortSignal.timeout(15000);
  const find = () => seen.slice(since).find((line) => line.startsWith(prefix));
  while (!find()) {
    await Promise.race([
      once(lines, 'line', { signal }),
      exited.then((result) => {
        throw (
          result.error ?? new Error(`Fixture exited before ${prefix}: ${JSON.stringify(result)}`)
        );
      }),
    ]);
  }
  return find();
}
async function readState() {
  const since = seen.length;
  child.stdin.write('read\n');
  return JSON.parse((await waitFor('STATE ', since)).slice(6));
}
function observation(result) {
  assert.ok(!result.error, result.text);
  const text = result.modelText ?? result.text;
  // Observation headers and actionable lines are the same model-facing format on every platform.
  const id = text.match(/observation_id=([^\s]+)/)?.[1];
  assert.ok(id, text);
  const elements = [...text.matchAll(/^\s*(s[0-9a-f]{8}:\d+)\s+\S+\s+"([^"\n]+)"/gm)];
  return { id, elements, text };
}
function screenshot(result) {
  assert.equal(
    result.screenshot?.mimeType,
    'image/png',
    'The native fixture must return a PNG screenshot',
  );
  const bytes = Buffer.from(result.screenshot.base64, 'base64');
  assert.ok(bytes.length >= 24);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(
    width >= 160 && width <= 800 && height >= 120 && height <= 800,
    `Unexpected fixture frame ${width}x${height}`,
  );
  return { width, height, bytes: bytes.length };
}
const selected = selectComputerUseBackend({ physicalInputRecentlyActive: () => false });
const report = {
  platform: process.platform,
  backendId: selected.backendId,
  doubleClick,
  status: 'running',
};
const context = {
  sessionId: 'platform-fixture',
  turnId: 'turn',
  toolCallId: 'call',
  cwd: process.cwd(),
  abortSignal: AbortSignal.timeout(40000),
  emitOutput() {},
};
try {
  await waitFor('READY');
  const [tool] = selected.tools;
  const read = await tool.impl(
    { action: 'observe', app: String(child.pid), include_screenshot: true },
    context,
  );
  const before = observation(read);
  report.screenshot = screenshot(read);
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`./results/platform-${process.platform}.png`, import.meta.url),
    Buffer.from(read.screenshot.base64, 'base64'),
  );
  const button = before.elements.find((row) => row[2] === 'Increment');
  assert.ok(button, before.text);
  const clicked = await tool.impl(
    { action: 'click_element', observation_id: before.id, element_id: button[1] },
    context,
  );
  const after = observation(clicked);
  assert.notEqual(after.id, before.id, 'Click must return a new observation');
  assert.match(clicked.text, /delivery:background/);
  report.click = clicked.text;
  const field = after.elements.find((row) => row[2] === 'Message');
  assert.ok(field, after.text);
  const written = await tool.impl(
    {
      action: 'set_value',
      observation_id: after.id,
      element_id: field[1],
      value: '玛卡 Cua 0.34.0',
    },
    context,
  );
  // Official 0.34.0 Windows ValuePattern returns legacy delivery=unknown even
  // when the value changed. Preserve Maka's refusal and confirm by observation.
  const valueDeliveryUnknown = process.platform === 'win32' && written.error === 'outcome_unknown';
  if (!valueDeliveryUnknown) {
    assert.notEqual(
      observation(written).id,
      after.id,
      'Setting a value must return a new observation',
    );
    assert.match(written.text, /delivery:background/);
  }
  report.valueDeliveryUnknown = valueDeliveryUnknown;
  report.setValue = written.text;
  const state = await readState();
  if (process.platform === 'win32') {
    assert.ok(state.sessionId > 0, 'Windows GUI acceptance requires an interactive user session');
  }
  assert.equal(state.count, 1);
  assert.equal(state.text, '玛卡 Cua 0.34.0');
  report.state = state;
  if (doubleClick) {
    assert.deepEqual(state.gesture, { doubleClicks: 0, physicalPresses: 0, activations: 0 });
    let current = valueDeliveryUnknown
      ? observation(
          await tool.impl(
            { action: 'observe', app: String(child.pid), include_screenshot: true },
            context,
          ),
        )
      : observation(written);
    for (let index = 0; index < 2; index++) {
      const target = current.elements.find((row) => row[2] === 'Double-click target');
      assert.ok(target, current.text);
      const clicked = await tool.impl(
        { action: 'click_element', observation_id: current.id, element_id: target[1] },
        { ...context, toolCallId: `gesture-single-${index}` },
      );
      const next = observation(clicked);
      assert.notEqual(next.id, current.id);
      current = next;
    }
    report.afterSingles = await readState();
    assert.deepEqual(report.afterSingles.gesture, {
      doubleClicks: 0,
      physicalPresses: 0,
      activations: 2,
    });
    const target = current.elements.find((row) => row[2] === 'Double-click target');
    assert.ok(target, current.text);
    const doubled = await tool.impl(
      { action: 'double_click_element', observation_id: current.id, element_id: target[1] },
      { ...context, toolCallId: 'double-click' },
    );
    const doubleDeliveryUnknown =
      process.platform === 'win32' && doubled.error === 'outcome_unknown';
    if (!doubleDeliveryUnknown) {
      assert.notEqual(observation(doubled).id, current.id);
      assert.match(doubled.text, /delivery:background/);
    }
    report.doubleDeliveryUnknown = doubleDeliveryUnknown;
    report.doubleClickResult = doubled.text;
    report.afterDoubleClickFrame = screenshot(
      doubleDeliveryUnknown
        ? await tool.impl(
            { action: 'observe', app: String(child.pid), include_screenshot: true },
            context,
          )
        : doubled,
    );
    report.afterDoubleClick = await readState();
    assert.equal(
      report.afterDoubleClick.gesture.doubleClicks,
      1,
      'A native double-click event is required',
    );
    assert.equal(
      report.afterDoubleClick.gesture.physicalPresses,
      2,
      'The native gesture must send two physical presses',
    );
  }
  report.status =
    report.valueDeliveryUnknown || report.doubleDeliveryUnknown
      ? 'passed-with-unknown-delivery'
      : 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  try {
    await selected.backend?.dispose?.();
  } catch (error) {
    report.status = 'failed';
    report.cleanupError = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    child.stdin.end('quit\n');
    report.fixtureExit = await exited;
    const exitFailed = report.fixtureExit.code !== 0;
    if (exitFailed) report.status = 'failed';
    lines.close();
    await mkdir(new URL('./results/', import.meta.url), { recursive: true });
    await writeFile(
      new URL(
        `./results/platform-${process.platform}${doubleClick ? '-double-click' : ''}.json`,
        import.meta.url,
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    assert.ok(!exitFailed, 'Fixture did not exit successfully');
  }
}
