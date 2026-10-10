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
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createCuaDriverBackend,
  selectComputerUseBackend,
} from '../../packages/computer-use/dist/index.js';
import { parseObservationText } from '../../packages/runtime/dist/__tests__/observation-text-reader.js';

function observation(result, previousId) {
  assert.ok(!result.error, result.text);
  const parsed = parseObservationText(result.modelText ?? result.text ?? '');
  assert.ok(parsed, result.text);
  if (previousId) {
    assert.notEqual(parsed.observation_id, previousId, 'Action must return a fresh observation');
  }
  return parsed;
}

function screenshot(result) {
  assert.equal(result.screenshot?.mimeType, 'image/png', 'A native window frame is required');
  const bytes = Buffer.from(result.screenshot.base64, 'base64');
  assert.ok(bytes.length >= 24);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width >= 320 && width <= 800 && height >= 180 && height <= 600);
  return { width, height, bytes: bytes.length };
}

export async function makaSmoke({ foreground = false, doubleClick = false, screenLocked } = {}) {
  assert.equal(process.platform, 'darwin', 'This harness requires the owned AppKit fixture');
  assert.ok(!screenLocked?.(), 'Unlock macOS before running the native fixture');
  const child = spawn(fileURLToPath(new URL('./results/Fixture', import.meta.url)), [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error: String(error) }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', () => {}); // Cleanup can race an already-exited fixture.
  const lines = createInterface({ input: child.stdout });
  const seen = [];
  lines.on('line', (line) => seen.push(line));
  const waitFor = async (expected, { since = 0, prefix = false } = {}) => {
    const signal = AbortSignal.timeout(10000);
    const find = () =>
      seen.slice(since).find((line) => (prefix ? line.startsWith(expected) : line === expected));
    while (!find()) {
      await Promise.race([
        once(lines, 'line', { signal }),
        exited.then((result) => {
          throw new Error(`Fixture exited before ${expected}: ${JSON.stringify(result)}`);
        }),
      ]);
    }
    return find();
  };
  const readCount = async () => {
    const since = seen.length;
    child.stdin.write('read\n');
    const count = Number((await waitFor('READ ', { since, prefix: true })).slice(5));
    assert.ok(Number.isInteger(count), 'Fixture must return an integer counter');
    return count;
  };
  const readGesture = async () => {
    const since = seen.length;
    child.stdin.write('gesture\n');
    return JSON.parse((await waitFor('GESTURE ', { since, prefix: true })).slice(8));
  };
  const requestedDelivery = foreground ? 'foreground' : 'background';
  const report = {
    requestedDelivery,
    doubleClick,
    runtime: process.versions.electron,
    status: 'running',
    authorization: 'Owned fixture callback; direct tool.impl bypasses Runtime Host admission',
    evidence: {},
  };
  const context = {
    sessionId: `maka-integration-smoke-${child.pid}`,
    turnId: 'turn',
    toolCallId: 'observe',
    cwd: process.cwd(),
    abortSignal: AbortSignal.timeout(40000),
    emitOutput() {},
  };
  const selected = selectComputerUseBackend({
    createBackend: (options) =>
      createCuaDriverBackend({
        ...options,
        async createDriver() {
          // Official SDK exports are import-only. Resolve its inspected root
          // entry directly so the standalone spike dependency cannot load a
          // second copy of the native library into Electron.
          const { CuaDriver } = await import(
            new URL('../../node_modules/@trycua/cua-driver/dist/index.js', import.meta.url).href
          );
          const native = CuaDriver.create(undefined);
          return {
            metadata: () => native.metadata(),
            shutdown: () => native.shutdown(),
            uniffiDestroy: () => native.uniffiDestroy(),
            async callTool(tool, args) {
              const result = await native.callTool(tool, args);
              if (tool === 'double_click') {
                // Record only the owned gesture's result, preserving dispatch.
                report.nativeDoubleClick = {
                  isError: result.isError,
                  structuredJson: result.structuredJson,
                };
              }
              return result;
            },
          };
        },
      }),
    physicalInputRecentlyActive: () => false,
    screenLocked,
    foregroundAuthorized: (candidate) =>
      foreground &&
      candidate.sessionId === context.sessionId &&
      candidate.turnId === context.turnId,
    overlay: {
      onActionBegin() {},
      onActionEnd(_action, result, candidate) {
        report.evidence[candidate.toolCallId] = result?.outcome;
      },
    },
  });
  report.backendId = selected.backendId;
  try {
    await waitFor(`READY ${child.pid}`);
    report.independentCountBefore = await readCount();
    assert.equal(report.independentCountBefore, 0);
    const [tool] = selected.tools;
    report.observe = await tool.impl(
      { action: 'observe', app: String(child.pid), include_screenshot: true },
      context,
    );
    const before = observation(report.observe);
    report.initialFrame = screenshot(report.observe);
    const button = before.elements.find((e) => e.label === 'Increment');
    assert.ok(button, report.observe.text);
    report.click = await tool.impl(
      {
        action: 'click_element',
        observation_id: before.observation_id,
        element_id: button.element_id,
        delivery: requestedDelivery,
      },
      { ...context, toolCallId: 'click' },
    );
    report.independentCount = await readCount();
    const after = observation(report.click, before.observation_id);
    assert.equal(report.evidence.click?.evidence?.requestedDelivery, requestedDelivery);
    assert.equal(report.evidence.click?.evidence?.actualDelivery, requestedDelivery);
    assert.match(report.click.text, new RegExp(`delivery:${requestedDelivery}`));
    report.afterClickFrame = screenshot(report.click);
    assert.equal(
      report.independentCount,
      1,
      'The native click must change the fixture counter once',
    );
    const field = after.elements.find((e) => e.label === 'Message');
    assert.ok(field, report.click.modelText);
    report.setValue = await tool.impl(
      {
        action: 'set_value',
        observation_id: after.observation_id,
        element_id: field.element_id,
        value: '玛卡 Cua 0.34.0',
      },
      { ...context, toolCallId: 'set-value' },
    );
    let current = observation(report.setValue, after.observation_id);
    assert.ok(
      ['background', 'not_applicable'].includes(
        report.evidence['set-value']?.evidence?.actualDelivery,
      ),
      'The AX value write must not use foreground input',
    );
    report.afterSetValueFrame = screenshot(report.setValue);
    child.stdin.write('text\n');
    await waitFor('TEXT 玛卡 Cua 0.34.0');
    report.independentText = '玛卡 Cua 0.34.0';
    if (doubleClick) {
      report.gestureBefore = await readGesture();
      assert.deepEqual(report.gestureBefore, {
        doubleClicks: 0,
        mouseClickCounts: [],
        semanticPresses: 0,
      });
      // A pair of independently dispatched AXPress actions is not a double click.
      for (let index = 0; index < 2; index++) {
        const target = current.elements.find((element) => element.label === 'Double-click target');
        assert.ok(target, 'The fixture must expose one semantic gesture target');
        const previousId = current.observation_id;
        const result = await tool.impl(
          {
            action: 'click_element',
            observation_id: previousId,
            element_id: target.element_id,
            delivery: 'background',
          },
          { ...context, toolCallId: `gesture-single-${index}` },
        );
        current = observation(result, previousId);
      }
      report.gestureAfterSingles = await readGesture();
      assert.deepEqual(report.gestureAfterSingles, {
        doubleClicks: 0,
        mouseClickCounts: [],
        semanticPresses: 2,
      });
      if (foreground) {
        // Delivery escalation requires a new observe call, not just an action's
        // returned snapshot, before reusing the task's foreground authority.
        report.beforeForegroundDoubleClick = await tool.impl(
          { action: 'observe', app: String(child.pid), include_screenshot: true },
          { ...context, toolCallId: 'observe-double-click' },
        );
        current = observation(report.beforeForegroundDoubleClick, current.observation_id);
      }
      const target = current.elements.find((element) => element.label === 'Double-click target');
      assert.ok(target);
      report.doubleClickResult = await tool.impl(
        {
          action: 'double_click_element',
          observation_id: current.observation_id,
          element_id: target.element_id,
          delivery: requestedDelivery,
        },
        { ...context, toolCallId: 'double-click' },
      );
      // Read application state even if adapter/native rejects the outcome.
      report.gestureAfterDoubleClick = await readGesture();
      observation(report.doubleClickResult, current.observation_id);
      assert.equal(report.evidence['double-click']?.evidence?.requestedDelivery, requestedDelivery);
      assert.equal(report.evidence['double-click']?.evidence?.actualDelivery, requestedDelivery);
      assert.match(report.doubleClickResult.text, new RegExp(`delivery:${requestedDelivery}`));
      report.afterDoubleClickFrame = screenshot(report.doubleClickResult);
      assert.deepEqual(
        report.gestureAfterDoubleClick,
        { doubleClicks: 1, mouseClickCounts: [1, 2], semanticPresses: 2 },
        'The dedicated native gesture must deliver a real double click, not two AXPress calls',
      );
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack : String(error);
    if (doubleClick && !report.gestureAfterDoubleClick) {
      try {
        report.gestureAtFailure = await readGesture();
      } catch (readbackError) {
        report.gestureReadbackError = String(readbackError);
      }
    }
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
      if (report.fixtureExit.code !== 0) report.status = 'failed';
      lines.close();
      await mkdir(new URL('./results/', import.meta.url), { recursive: true });
      await writeFile(
        new URL(
          `./results/maka${doubleClick ? '-double-click' : ''}${foreground ? '-foreground' : ''}.json`,
          import.meta.url,
        ),
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify({
          status: report.status,
          requestedDelivery,
          backendId: report.backendId,
          count: report.independentCount,
          text: report.independentText,
          gesture: report.gestureAfterDoubleClick,
          evidence: report.evidence,
          fixtureExit: report.fixtureExit,
        }),
      );
      assert.equal(report.fixtureExit.code, 0, 'Fixture must exit successfully');
    }
  }
}
