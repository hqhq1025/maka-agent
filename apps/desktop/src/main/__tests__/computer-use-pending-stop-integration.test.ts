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
import { createCuaDriverBackend, type CuaDriverPort } from '@maka/computer-use';
import { deferred } from '@maka/core/test-only/async-primitives';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { parseObservationText } from '@maka/runtime/test-only/observation-text-reader';
import { createComputerUsePresentationFeed } from '../computer-use/presentation-feed.js';

for (const platform of ['linux', 'win32', 'darwin'] as const) {
  test(`${platform} adapter keeps a stopped native call pending until its result settles`, async () => {
    const entered = deferred<void>();
    const nativeRelease = deferred<void>();
    let clicks = 0;
    let token = 0;
    const port: CuaDriverPort = {
      async metadata() {
        return { driverVersion: '0.34.0' };
      },
      async callTool(name) {
        let data: unknown = {};
        if (name === 'check_permissions') {
          data = {
            x11: true,
            atspi: true,
            uia: true,
            accessibility: true,
            screen_recording: true,
          };
        }
        if (name === 'list_apps') {
          data = {
            apps: [{ pid: 42, name: 'Fixture', bundle_id: 'test.fixture', running: true }],
          };
        }
        if (name === 'list_windows') {
          data = { windows: [{ pid: 42, window_id: 7, title: 'Counter' }] };
        }
        if (name === 'get_window_state') {
          data = {
            pid: 42,
            window_id: 7,
            tree_markdown: 'Count = 0',
            elements: [
              {
                element_index: 1,
                element_token: `s${++token}:1`,
                role:
                  platform === 'linux'
                    ? 'push button'
                    : platform === 'win32'
                      ? 'Button'
                      : 'AXButton',
                label: 'Increment',
                actions: ['AXPress'],
              },
            ],
          };
        }
        if (name === 'click') {
          clicks += 1;
          if (clicks === 1) {
            entered.resolve();
            await nativeRelease.promise;
          }
          data = {
            effect: 'confirmed',
            route: 'accessibility',
            delivery: { mode: 'background' },
          };
        }
        return { isError: false, structuredJson: JSON.stringify(data), images: [] };
      },
      async shutdown() {},
      uniffiDestroy() {},
    };
    const backend = createCuaDriverBackend({ platform, createDriver: async () => port });
    const feed = createComputerUsePresentationFeed();
    const tools = buildComputerUseTools({ backend, overlay: feed.wrap({ onActionBegin() {} }) });
    const [tool] = tools;
    const invoke = async (...args: Parameters<typeof tool.impl>) =>
      (await tool.impl(...args)) as { text: string; modelText?: string; error?: string };
    const context = (
      sessionId: string,
      toolCallId: string,
      abortSignal = new AbortController().signal,
    ) => ({
      sessionId,
      toolCallId,
      turnId: 'turn-1',
      cwd: '/tmp',
      abortSignal,
      emitOutput() {},
    });
    const observe = async (sessionId: string) => {
      const result = await invoke(
        { action: 'observe', app: 'Fixture', include_screenshot: false },
        context(sessionId, 'observe'),
      );
      assert.equal(result.error, undefined, result.text);
      const observation = parseObservationText(result.modelText ?? result.text);
      assert.ok(observation, result.modelText ?? result.text);
      return observation;
    };
    try {
      const first = await observe('task-a');
      const abort = new AbortController();
      let settled = false;
      const click = invoke(
        {
          action: 'click_element',
          observation_id: first.observation_id,
          element_id: first.elements[0]!.element_id,
        },
        context('task-a', 'click', abort.signal),
      );
      void click.then(() => {
        settled = true;
      });
      await entered.promise;
      feed.stopping('task-a');
      tools.clearSession('task-a');
      feed.release('task-a');
      abort.abort();
      feed.complete('task-a');
      let nextObserved = false;
      const next = observe('task-b').then((value) => {
        nextObserved = true;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(nextObserved, false);
      assert.equal(feed.read('task-a')?.state, 'stopping');
      assert.equal(clicks, 1);

      nativeRelease.resolve();
      assert.equal((await click).error, 'outcome_unknown');
      assert.equal(feed.read('task-a')?.state, 'stopped');
      assert.equal(feed.read('task-a')?.frame, undefined);
      const fresh = await next;
      const stale = await invoke(
        {
          action: 'click_element',
          observation_id: first.observation_id,
          element_id: first.elements[0]!.element_id,
        },
        context('task-b', 'stale'),
      );
      assert.ok(stale.error);
      assert.equal(clicks, 1);
      const recovered = await invoke(
        {
          action: 'click_element',
          observation_id: fresh.observation_id,
          element_id: fresh.elements[0]!.element_id,
        },
        context('task-b', 'recovered'),
      );
      assert.equal(recovered.error, undefined, recovered.text);
      assert.equal(clicks, 2);
    } finally {
      nativeRelease.resolve();
      feed.dispose();
      await backend.dispose();
    }
  });
}
