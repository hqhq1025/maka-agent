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
  createCuaDriverBackend,
  type CuaDriverPort,
  type CuaDriverBackendOptions,
} from '../cua-driver-backend.js';
import { buildComputerUseTools } from '@maka/runtime/computer-use-tools';
import { parseObservationText } from '@maka/runtime/test-only/observation-text-reader';
import { selectComputerUseBackend } from '../select-backend.js';

const context = { sessionId: 'task-a', turnId: 'turn', toolCallId: 'call' };
const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(options: CuaDriverBackendOptions = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let token = 0;
  let effect = 'unverifiable';
  let route: string | undefined = 'accessibility';
  let delivery = 'background';
  let beforeCall: ((name: string) => Promise<void>) | undefined;
  let block: (() => Promise<void>) | undefined;
  let shutdown = false;
  let destroyed = false;
  let permissions: Record<string, unknown> = {};
  let windows: Array<Record<string, unknown>> = [{ pid: 42, window_id: 7, title: 'Counter' }];
  let snapshotBounds: Record<string, number> | undefined;
  const port: CuaDriverPort = {
    async metadata() {
      return { driverVersion: '0.34.0' };
    },
    async callTool(name, json) {
      const args = JSON.parse(json);
      calls.push({ name, args });
      await beforeCall?.(name);
      let data: unknown = {};
      if (name === 'check_permissions') data = permissions;
      if (name === 'list_apps')
        data = { apps: [{ pid: 42, name: 'Fixture', bundle_id: 'test.fixture', running: true }] };
      if (name === 'launch_app') data = { pid: 42, name: 'Fixture', windows: [] };
      if (name === 'list_windows') data = { windows };
      if (name === 'launch_app')
        data = { pid: 42, name: 'Fixture', windows: [{ window_id: 7, title: 'Counter' }] };
      if (name === 'get_window_state')
        data = {
          pid: 42,
          window_id: args.window_id ?? 7,
          ...(snapshotBounds ? { window_bounds: snapshotBounds } : {}),
          tree_markdown: 'Count = 1',
          elements: [
            {
              element_index: 1,
              element_token: `s${++token}:1`,
              role:
                options.platform === 'linux'
                  ? 'push button'
                  : options.platform === 'win32'
                    ? 'Button'
                    : 'AXButton',
              label: 'Increment',
              actions: ['AXPress'],
            },
          ],
        };
      if (['click', 'double_click', 'set_value', 'press_key', 'type_text'].includes(name)) {
        await block?.();
        data = { effect, route, delivery: { mode: delivery } };
      }
      return { isError: false, structuredJson: JSON.stringify(data), images: [] };
    },
    async shutdown() {
      shutdown = true;
    },
    uniffiDestroy() {
      assert.equal(shutdown, true);
      destroyed = true;
    },
  };
  const backend = createCuaDriverBackend({ createDriver: async () => port, ...options });
  const observe = (sessionId = context.sessionId) =>
    backend.observeApp!({ app: 'Fixture', includeScreenshot: false }, signal(), {
      ...context,
      sessionId,
    });
  return {
    backend,
    calls,
    observe,
    port,
    setPermissions: (value: Record<string, unknown>) => {
      permissions = value;
    },
    setWindows: (value: Array<Record<string, unknown>>) => {
      windows = value;
    },
    setSnapshotBounds: (value: Record<string, number>) => {
      snapshotBounds = value;
    },
    setRoute: (value: string | undefined) => {
      route = value;
    },
    setDelivery: (value: string) => {
      delivery = value;
    },
    beforeCall: (fn: (name: string) => Promise<void>) => {
      beforeCall = fn;
    },
    setEffect: (value: string) => {
      effect = value;
    },
    setBlock: (fn: () => Promise<void>) => {
      block = fn;
    },
    destroyed: () => destroyed,
  };
}

const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAAJklEQVR4nGPkUbJgoCVgoqnpoxaMWjBqwagFoxaMWjBqwagFVAMAgiwAlqig/o8AAAAASUVORK5CYII=';
function pixelFixture(
  options: CuaDriverBackendOptions = {},
  metadata: Record<string, unknown> = {},
  png = PIXEL_PNG,
) {
  const f = fixture(options);
  const native = f.port.callTool;
  f.port.callTool = async (name, args) => {
    const result = await native(name, args);
    if (name !== 'get_window_state' || !JSON.parse(args).include_screenshot) return result;
    return {
      ...result,
      structuredJson: JSON.stringify({
        ...JSON.parse(result.structuredJson!),
        capture_id: 'native-capture',
        screenshot_width: 32,
        screenshot_height: 24,
        ...metadata,
      }),
      images: [{ mimeType: 'image/png', dataBase64: png }],
    };
  };
  return {
    ...f,
    observePixels: () =>
      f.backend.observeApp!({ app: 'Fixture', includeScreenshot: true }, signal(), context),
  };
}

test('pixel typing and key chords use the current exact-window image without an AX token or unsupported capture argument', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const f = pixelFixture({ platform });
    const observed = await f.observePixels();
    const session = f.calls.find((call) => call.name === 'start_session')!.args.session;
    const typed = await f.backend.runSemantic!(
      {
        type: 'type',
        observationId: observed.observationId,
        coordinate: [31, 23],
        text: 'A paragraph',
      },
      signal(),
      context,
    );
    assert.deepEqual(f.calls.find((call) => call.name === 'type_text')?.args, {
      session,
      pid: 42,
      window_id: 7,
      x: 31,
      y: 23,
      text: 'A paragraph',
      delivery_mode: 'background',
    });
    assert.equal(typed.outcome.ok && typed.outcome.verified, false);
    assert.ok(typed.observation);
    const keyed = await f.backend.runSemantic!(
      {
        type: 'press_key',
        observationId: typed.observation.observationId,
        coordinate: [4, 6],
        key: 'Ctrl+S',
        delivery: 'foreground',
      },
      signal(),
      { ...context, foregroundAuthorized: true },
    );
    assert.equal(keyed.outcome.ok, true);
    assert.deepEqual(f.calls.find((call) => call.name === 'press_key')?.args, {
      session,
      pid: 42,
      window_id: 7,
      x: 4,
      y: 6,
      key: 'S',
      modifiers: ['ctrl'],
      delivery_mode: 'foreground',
    });
    await f.backend.dispose();
  }
});

test('focused Windows input preserves selection through fresh observations without a second pixel click', async () => {
  const f = pixelFixture({
    platform: 'win32',
    presentationTargetIdentity: {
      acquire: () => 'retained-window',
      validate: () => true,
      validateForeground: () => true,
      release() {},
    },
  });
  f.setDelivery('foreground');
  let selection = false;
  let text = 'Existing document';
  const native = f.port.callTool;
  f.port.callTool = async (name, json) => {
    const args = JSON.parse(json);
    if (name === 'press_key' || name === 'type_text') {
      if (args.x !== undefined || args.element_token !== undefined) selection = false;
      if (name === 'press_key' && args.key === 'A' && args.modifiers.includes('ctrl'))
        selection = true;
      if (name === 'type_text') text = selection ? args.text : text + args.text;
    }
    return native(name, json);
  };
  const runContext = { ...context, foregroundAuthorized: true };
  const observed = await f.observePixels();
  await f.backend.runSemantic!(
    {
      type: 'press_key',
      observationId: observed.observationId,
      focus: 'current',
      key: 'Ctrl+A',
      delivery: 'foreground',
    },
    signal(),
    runContext,
  );
  const fresh = await f.observePixels();
  await f.backend.runSemantic!(
    {
      type: 'type',
      observationId: fresh.observationId,
      focus: 'current',
      text: 'Replacement document',
      delivery: 'foreground',
    },
    signal(),
    runContext,
  );
  assert.equal(text, 'Replacement document');
  const calls = f.calls.filter((call) => ['type_text', 'press_key'].includes(call.name));
  assert.equal(calls.length, 2);
  for (const { args } of calls) {
    assert.equal(args.pid, 42);
    assert.equal(args.window_id, 7);
    assert.equal(args.x, undefined);
    assert.equal(args.element_token, undefined);
    assert.equal(args.delivery_mode, 'foreground');
  }
  await f.backend.dispose();
});

test('focused input refuses missing authority and rechecks retained native identity after presentation', async () => {
  for (const scenario of [
    'missing-lease',
    'revoked-lease',
    'no-image',
    'background',
    'ungranted',
    'wrong-platform',
    'missing-foreground-check',
    'foreground-check-error',
  ] as const) {
    let valid = true;
    const f = pixelFixture({
      platform: scenario === 'wrong-platform' ? 'darwin' : 'win32',
      ...(scenario === 'missing-lease'
        ? {}
        : {
            presentationTargetIdentity: {
              acquire: () => 'retained-window',
              validate: () => valid,
              ...(scenario === 'missing-foreground-check'
                ? {}
                : {
                    validateForeground: () => {
                      if (scenario === 'foreground-check-error') throw new Error('unavailable');
                      return true;
                    },
                  }),
              release() {},
            },
          }),
    });
    const observed = scenario === 'no-image' ? await f.observe() : await f.observePixels();
    const result = await f.backend.runSemantic!(
      {
        type: 'type',
        observationId: observed.observationId,
        focus: 'current',
        text: 'Never sent',
        ...(scenario === 'background' ? {} : { delivery: 'foreground' }),
      },
      signal(),
      {
        ...context,
        foregroundAuthorized: scenario !== 'ungranted',
        beforeNativeDispatch: async () => {
          if (scenario === 'revoked-lease') valid = false;
        },
      },
    );
    assert.equal(result.outcome.ok, false, scenario);
    assert.equal(
      f.calls.some((call) => call.name === 'type_text'),
      false,
      scenario,
    );
    await f.backend.dispose();
  }
});

test('focused Windows input refuses a different foreground window before or after presentation', async () => {
  for (const action of ['type', 'press_key'] as const) {
    for (const changedAt of ['before-action', 'during-presentation'] as const) {
      let foreground = changedAt !== 'before-action';
      const identity = {
        acquire: () => 'retained-window',
        validate: () => true,
        validateForeground: () => foreground,
        release() {},
      };
      const f = pixelFixture({ platform: 'win32', presentationTargetIdentity: identity });
      const observed = await f.observePixels();
      const result = await f.backend.runSemantic!(
        {
          ...(action === 'type'
            ? { type: 'type', text: 'Never sent' }
            : { type: 'press_key', key: 'Ctrl+S' }),
          observationId: observed.observationId,
          focus: 'current',
          delivery: 'foreground',
        },
        signal(),
        {
          ...context,
          foregroundAuthorized: true,
          beforeNativeDispatch: async () => {
            foreground = false;
          },
        },
      );
      assert.equal(result.outcome.ok, false, `${action}: ${changedAt}`);
      assert.equal(result.outcome.evidence?.path, 'none');
      assert.equal(
        f.calls.some((call) => ['type_text', 'press_key'].includes(call.name)),
        false,
      );
      await f.backend.dispose();
    }
  }
});

for (const invalidity of [
  'foreground',
  'identity',
  'identity-error',
  'foreground-error',
] as const) {
  for (const changedAt of ['before-action', 'before-native-dispatch'] as const) {
    test(`${invalidity} lost ${changedAt} invalidates the public frame until a fresh observation`, async (t) => {
      let invalid = false;
      let checks = 0;
      const f = pixelFixture({ platform: 'win32' });
      f.setPermissions({ uia: true });
      f.setDelivery('foreground');
      const selected = selectComputerUseBackend({
        foregroundAuthorized: () => true,
        createBackend: (options) =>
          createCuaDriverBackend({
            ...options,
            platform: 'win32',
            createDriver: async () => f.port,
            presentationTargetIdentity: {
              acquire: () => 'retained-window',
              validate: () => {
                if (invalid) checks += 1;
                const fail = invalid && (changedAt === 'before-action' || checks >= 2);
                if (fail && invalidity === 'identity-error')
                  throw new Error('native identity unavailable');
                return !(fail && invalidity === 'identity');
              },
              validateForeground: () => {
                const fail = invalid && (changedAt === 'before-action' || checks >= 2);
                if (fail && invalidity === 'foreground-error')
                  throw new Error('native foreground unavailable');
                return !(fail && invalidity === 'foreground');
              },
              release() {},
            },
          }),
      });
      t.after(async () => {
        await selected.backend?.dispose?.();
        await f.backend.dispose();
      });
      const [tool] = selected.tools;
      let callId = 0;
      const invoke = (input: Record<string, unknown>) =>
        tool!.impl(input as never, {
          ...context,
          toolCallId: `focus-${++callId}`,
          cwd: '/tmp',
          abortSignal: signal(),
          emitOutput() {},
        }) as Promise<{ text: string; modelText?: string; error?: string }>;
      const first = await invoke({ action: 'observe', app: 'Fixture', include_screenshot: true });
      const observed = parseObservationText(first.modelText ?? first.text);
      assert.ok(observed, first.text);
      invalid = true;
      const refused = await invoke({
        action: 'type',
        observation_id: observed.observation_id,
        text: 'Never sent',
        focus: 'current',
        delivery: 'foreground',
      });
      assert.ok(refused.error, refused.text);
      assert.doesNotMatch(refused.modelText ?? refused.text, /still current|reached the executor/);
      assert.equal(checks, changedAt === 'before-action' ? 1 : 2);
      assert.equal(
        selected.tools.sessionEvents.snapshot(context.sessionId).status,
        'reobserve_required',
      );
      invalid = false;
      const stale = await invoke({
        action: 'press_key',
        observation_id: observed.observation_id,
        text: 'Ctrl+S',
        focus: 'current',
        delivery: 'foreground',
      });
      assert.ok(stale.error, stale.text);
      assert.equal(
        f.calls.some((call) => ['type_text', 'press_key'].includes(call.name)),
        false,
      );
      const refreshed = await invoke({
        action: 'observe',
        app: 'Fixture',
        include_screenshot: true,
      });
      const fresh = parseObservationText(refreshed.modelText ?? refreshed.text);
      assert.ok(fresh, refreshed.text);
      assert.notEqual(fresh.observation_id, observed.observation_id);
      const accepted = await invoke({
        action: 'type',
        observation_id: fresh.observation_id,
        text: 'Fresh input',
        focus: 'current',
        delivery: 'foreground',
      });
      assert.equal(accepted.error, undefined, accepted.text);
      assert.equal(f.calls.filter((call) => call.name === 'type_text').length, 1);
    });
  }
}

test('a retired focused action cannot invalidate its successor session after presentation', async (t) => {
  let valid = true;
  const invalidated: string[] = [];
  const f = pixelFixture({
    platform: 'win32',
    presentationTargetIdentity: {
      acquire: () => 'retained-window',
      validate: () => valid,
      validateForeground: () => true,
      release() {},
    },
    onSessionInvalidated: ({ sessionId }) => invalidated.push(sessionId),
  });
  t.after(() => f.backend.dispose());
  const observed = await f.observePixels();
  let successor: ReturnType<typeof f.observePixels> | undefined;
  const refused = await f.backend.runSemantic!(
    {
      type: 'type',
      observationId: observed.observationId,
      focus: 'current',
      delivery: 'foreground',
      text: 'Never sent',
    },
    signal(),
    {
      ...context,
      foregroundAuthorized: true,
      beforeNativeDispatch: async () => {
        f.backend.clearSession!(context.sessionId);
        valid = false;
        successor = f.observePixels();
      },
    },
  );
  assert.equal(refused.outcome.ok, false);
  assert.deepEqual(invalidated, []);
  assert.equal(
    f.calls.some((call) => call.name === 'type_text'),
    false,
  );
  valid = true;
  const fresh = await successor;
  assert.ok(fresh);
  const accepted = await f.backend.runSemantic!(
    {
      type: 'click_element',
      observationId: fresh.observationId,
      elementId: fresh.elements[0]!.elementId,
    },
    signal(),
    context,
  );
  assert.equal(accepted.outcome.ok, true);
  assert.equal(f.calls.filter((call) => call.name === 'click').length, 1);
});

test('an incorrect element identity preserves the valid observation for a corrected action', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const f = fixture({ platform });
    try {
      const observed = await f.observe();
      const action = {
        type: 'click_element' as const,
        observationId: observed.observationId,
        elementId: observed.elements[0]!.elementId,
      };
      const refused = await f.backend.runSemantic!(
        {
          ...action,
          elementIdentity: { ...observed.elements[0]!.identity!, token: 'wrong-token' },
        },
        signal(),
        context,
      );
      assert.equal(!refused.outcome.ok && refused.outcome.error, 'target_mismatch');
      assert.equal(
        f.calls.some((call) => call.name === 'click'),
        false,
      );
      const accepted = await f.backend.runSemantic!(action, signal(), context);
      assert.equal(accepted.outcome.ok, true);
      assert.equal(f.calls.filter((call) => call.name === 'click').length, 1);
    } finally {
      await f.backend.dispose();
    }
  }
});

test('pixel input refuses absent, invalid, resized or mismatched capture proof before native input', async () => {
  const variants = [
    { metadata: { capture_id: undefined } },
    { metadata: { screenshot_frame_valid: false } },
    { metadata: { screenshot_width: 31 } },
    { metadata: { screenshot_original_width: 64 } },
    { metadata: {}, png: 'AA==' },
  ];
  for (const variant of variants) {
    const f = pixelFixture({}, variant.metadata, variant.png);
    const observed = await f.observePixels();
    const result = await f.backend.runSemantic!(
      { type: 'type', observationId: observed.observationId, coordinate: [0, 0], text: 'No input' },
      signal(),
      context,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'capture_failed');
    assert.equal(
      f.calls.some((call) => call.name === 'type_text'),
      false,
    );
    await f.backend.dispose();
  }
  const f = pixelFixture();
  const observed = await f.observe();
  const result = await f.backend.runSemantic!(
    { type: 'press_key', observationId: observed.observationId, coordinate: [0, 0], key: 'Enter' },
    signal(),
    context,
  );
  assert.equal(!result.outcome.ok && result.outcome.error, 'capture_failed');
  assert.equal(
    f.calls.some((call) => call.name === 'press_key'),
    false,
  );
  await f.backend.dispose();
});

test('pixel targets reject out-of-image coordinates and mixed element addressing', async () => {
  for (const target of [
    { coordinate: [-1, 2] },
    { coordinate: [32, 2] },
    { coordinate: [3, 24] },
    { coordinate: [0.5, 0] },
    { coordinate: [NaN, 0] },
    { coordinate: [0, 0], elementId: 's1:1' },
  ]) {
    const f = pixelFixture();
    const observed = await f.observePixels();
    const result = await f.backend.runSemantic!(
      { type: 'type', observationId: observed.observationId, ...target, text: 'No input' } as never,
      signal(),
      context,
    );
    assert.equal(!result.outcome.ok && result.outcome.error, 'invalid_coordinate');
    assert.equal(
      f.calls.some((call) => call.name === 'type_text'),
      false,
    );
    await f.backend.dispose();
  }
});

test('pixel input rechecks revocation after presentation and consumes unknown effects without replay', async () => {
  let authorized = true;
  const f = pixelFixture({ foregroundAuthorized: () => authorized });
  const observed = await f.observePixels();
  const action = {
    type: 'type' as const,
    observationId: observed.observationId,
    coordinate: [5, 6] as [number, number],
    text: 'Once',
    delivery: 'foreground' as const,
  };
  const refused = await f.backend.runSemantic!(action, signal(), {
    ...context,
    foregroundAuthorized: true,
    beforeNativeDispatch: async () => {
      authorized = false;
    },
  });
  assert.equal(!refused.outcome.ok && refused.outcome.error, 'policy_denied');
  assert.equal(
    f.calls.some((call) => call.name === 'type_text'),
    false,
  );
  authorized = true;
  f.setEffect('partial');
  const unknown = await f.backend.runSemantic!(action, signal(), {
    ...context,
    foregroundAuthorized: true,
  });
  assert.equal(!unknown.outcome.ok && unknown.outcome.error, 'outcome_unknown');
  const replay = await f.backend.runSemantic!(action, signal(), {
    ...context,
    foregroundAuthorized: true,
  });
  assert.equal(!replay.outcome.ok && replay.outcome.error, 'stale_frame');
  assert.equal(f.calls.filter((call) => call.name === 'type_text').length, 1);
  await f.backend.dispose();
});

test('the production tool binds pixel input to its public screenshot observation and fences an unknown replay', async () => {
  const f = pixelFixture({ platform: 'win32' });
  f.setPermissions({ uia: true });
  const [tool] = buildComputerUseTools({ backend: f.backend, foregroundAuthorized: () => true });
  const runtimeContext = { ...context, cwd: '/tmp', abortSignal: signal(), emitOutput() {} };
  const observed = (await tool.impl(
    { action: 'observe', app: 'Fixture', include_screenshot: true },
    runtimeContext,
  )) as { text: string };
  assert.doesNotMatch(observed.text, /native-capture/);
  f.setEffect('partial');
  const action = {
    action: 'type',
    observation_id: JSON.parse(observed.text).observation_id,
    coordinate: [12, 8],
    text: 'Insert this only once.',
    delivery: 'foreground',
  };
  const typed = (await tool.impl(action, { ...runtimeContext, toolCallId: 'pixel-type' })) as {
    error?: string;
  };
  assert.equal(typed.error, 'outcome_unknown');
  const dispatched = f.calls.filter((call) => call.name === 'type_text');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].args.x, 12);
  assert.equal(dispatched[0].args.y, 8);
  assert.equal(dispatched[0].args.window_id, 7);
  const replay = (await tool.impl(action, { ...runtimeContext, toolCallId: 'pixel-replay' })) as {
    error?: string;
  };
  assert.equal(replay.error, 'reobserve_required');
  assert.equal(f.calls.filter((call) => call.name === 'type_text').length, 1);
  await f.backend.dispose();
});

test('window movement during AX-only capture suppresses cursor geometry without another snapshot', async () => {
  const f = fixture({ platform: 'darwin' });
  f.setWindows([
    {
      pid: 42,
      window_id: 7,
      title: 'Counter',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      is_on_screen: true,
      on_current_space: true,
    },
  ]);
  f.beforeCall(async (name) => {
    if (name === 'get_window_state')
      f.setWindows([
        {
          pid: 42,
          window_id: 7,
          title: 'Counter',
          bounds: { x: 10, y: 0, width: 100, height: 100 },
          is_on_screen: true,
          on_current_space: true,
        },
      ]);
  });
  const observed = await f.observe();
  assert.equal(observed.windowBounds, undefined);
  assert.equal(observed.presentationVisibility, 'unavailable');
  assert.equal(f.calls.filter((call) => call.name === 'get_window_state').length, 1);
  const snapshotIndex = f.calls.findIndex((call) => call.name === 'get_window_state');
  assert.deepEqual(f.calls[snapshotIndex + 1], { name: 'list_windows', args: { pid: 42 } });
  assert.deepEqual(f.calls[snapshotIndex - 1], { name: 'list_windows', args: { pid: 42 } });
});

test('production Runtime waits for native target checks before showing the action cursor', async () => {
  let allowed = false;
  const f = fixture({ platform: 'darwin', foregroundAuthorized: () => allowed });
  f.setPermissions({ accessibility: true, screen_recording: true });
  const events: string[] = [];
  const ready = deferred();
  const entered = deferred();
  const [tool] = buildComputerUseTools({
    backend: f.backend,
    foregroundAuthorized: () => allowed,
    overlay: {
      onActionBegin() {
        events.push('cursor');
        entered.resolve();
        return { readyForInteraction: ready.promise, finished: Promise.resolve() };
      },
    },
  });
  const toolContext = { ...context, cwd: '/tmp', abortSignal: signal(), emitOutput() {} };
  const observed = (await tool.impl({ action: 'observe', app: 'Fixture' }, toolContext)) as {
    text: string;
  };
  const input = {
    action: 'click_element',
    delivery: 'foreground',
    element_id: 's1:1',
    observation_id: JSON.parse(observed.text).observation_id,
  } as const;
  const denied = (await tool.impl(input, toolContext)) as { error?: string };
  assert.equal(denied.error, 'policy_denied');
  assert.deepEqual(events, []);
  assert.equal(f.calls.filter(({ name }) => name === 'click').length, 0);

  allowed = true;
  const fresh = (await tool.impl(
    { action: 'observe', app: 'Fixture' },
    { ...toolContext, toolCallId: 'fresh' },
  )) as { text: string };
  const pending = tool.impl(
    { ...input, element_id: 's2:1', observation_id: JSON.parse(fresh.text).observation_id },
    { ...toolContext, toolCallId: 'accepted' },
  );
  await entered.promise;
  assert.deepEqual(events, ['cursor']);
  assert.equal(f.calls.filter(({ name }) => name === 'click').length, 0);
  allowed = false;
  ready.resolve();
  const revoked = (await pending) as { error?: string };
  assert.equal(revoked.error, 'policy_denied');
  assert.equal(f.calls.filter(({ name }) => name === 'click').length, 0);
  await f.backend.dispose?.();
});

test('native lock and target changes around the cursor fence prevent input', async () => {
  for (const change of ['locked-before', 'locked-after', 'target-after'] as const) {
    let locked = false;
    let begins = 0;
    const f = fixture({ platform: 'darwin', screenLocked: () => locked });
    const observed = await f.observe();
    locked = change === 'locked-before';
    const result = await f.backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observed.observationId,
        elementId: observed.elements[0]!.elementId,
      },
      signal(),
      {
        ...context,
        beforeNativeDispatch: async () => {
          begins += 1;
          if (change === 'locked-after') locked = true;
          if (change === 'target-after') f.backend.clearSession?.(context.sessionId);
        },
      },
    );
    assert.equal(result.outcome.ok, false);
    assert.equal(begins, change === 'locked-before' ? 0 : 1);
    assert.equal(f.calls.filter(({ name }) => name === 'click').length, 0);
    await f.backend.dispose?.();
  }
});

test('stable AX-only geometry bracket supplies the observed window bounds', async () => {
  const f = fixture({ platform: 'darwin' });
  f.setWindows([
    {
      pid: 42,
      window_id: 7,
      bounds: { x: 100, y: 50, width: 400, height: 300 },
      is_on_screen: true,
      on_current_space: true,
    },
  ]);
  const observed = await f.observe();
  assert.deepEqual(observed.windowBounds, { x: 100, y: 50, width: 400, height: 300 });
  assert.equal(observed.presentationVisibility, 'visible');
});

test('snapshot bounds stay tied to element frames when fresh metadata reports a different location', async () => {
  const f = fixture({ platform: 'darwin' });
  const snapshot = { x: 100, y: 50, width: 400, height: 300 };
  f.setSnapshotBounds(snapshot);
  f.setWindows([
    { pid: 42, window_id: 7, bounds: snapshot, is_on_screen: true, on_current_space: true },
  ]);
  f.beforeCall(async (name) => {
    if (name === 'get_window_state')
      f.setWindows([
        {
          pid: 42,
          window_id: 7,
          bounds: { ...snapshot, x: 110 },
          is_on_screen: true,
          on_current_space: true,
        },
      ]);
  });
  const observed = await f.observe();
  assert.deepEqual(observed.windowBounds, snapshot);
  assert.equal(observed.presentationVisibility, 'unavailable');
});

for (const state of [
  { is_on_screen: false, on_current_space: true },
  { is_on_screen: true, on_current_space: false },
  { is_on_screen: true, on_current_space: true, minimized: true },
  { is_on_screen: true },
]) {
  test(`unavailable presentation metadata ${JSON.stringify(state)} does not discard AX or admit a cursor`, async () => {
    const f = fixture({ platform: 'darwin' });
    f.setWindows([
      { pid: 42, window_id: 7, bounds: { x: 100, y: 50, width: 400, height: 300 }, ...state },
    ]);
    const observed = await f.observe();
    assert.equal(observed.accessibilityText, 'Count = 1');
    assert.equal(observed.presentationVisibility, 'unavailable');
    assert.equal(observed.elements.length, 1);
  });
}

for (const actionType of ['click_element', 'double_click_element'] as const) {
  test(`SDK ${actionType} binds task/window/token and preserves unverified native effect`, async () => {
    const f = fixture();
    const observation = await f.observe();
    const result = await f.backend.runSemantic!(
      {
        type: actionType,
        observationId: observation.observationId,
        elementId: observation.elements[0].elementId,
      },
      signal(),
      context,
    );
    assert.equal(result.outcome.ok, true);
    if (result.outcome.ok) {
      assert.equal(result.outcome.verified, false);
      assert.equal(result.outcome.evidence?.effect, 'unverifiable');
    }
    assert.equal(result.observation?.accessibilityText, 'Count = 1');
    const nativeTool = actionType === 'double_click_element' ? 'double_click' : 'click';
    const dispatched = f.calls.find((c) => c.name === nativeTool)!.args;
    assert.equal(dispatched.pid, 42);
    assert.equal(dispatched.window_id, 7);
    assert.equal(dispatched.element_token, observation.elements[0].elementId);
    assert.equal(dispatched.delivery_mode, 'background');
    assert.deepEqual(Object.keys(dispatched).sort(), [
      'delivery_mode',
      'element_token',
      'pid',
      'session',
      'window_id',
    ]);
    const repeated = await f.backend.runSemantic!(
      {
        type: actionType,
        observationId: observation.observationId,
        elementId: observation.elements[0].elementId,
      },
      signal(),
      context,
    );
    assert.equal(repeated.outcome.ok, false);
    assert.equal(f.calls.filter((c) => c.name === nativeTool).length, 1);
    assert.equal(
      f.calls.some((c) => c.name === (nativeTool === 'click' ? 'double_click' : 'click')),
      false,
    );
    await f.backend.dispose();
    assert.equal(f.destroyed(), true);
  });
}

test('clearing a starting session rejects its late result and ends the native session', async () => {
  const f = fixture();
  const entered = deferred();
  const pending = deferred();
  f.beforeCall(async (name) => {
    if (name === 'start_session') {
      entered.resolve();
      await pending.promise;
    }
  });
  const observing = f.observe();
  const rejected = assert.rejects(observing, /aborted/);
  await entered.promise;
  f.backend.clearSession!(context.sessionId);
  pending.resolve();
  await rejected;
  await f.backend.dispose();
  assert.equal(f.calls.filter((c) => c.name === 'get_window_state').length, 0);
  assert.equal(f.calls.filter((c) => c.name === 'end_session').length, 1);
  assert.equal(
    f.calls.find((c) => c.name === 'start_session')?.args.session,
    f.calls.find((c) => c.name === 'end_session')?.args.session,
  );
});

for (const operation of ['observe', 'launch'] as const) {
  test(`clearing a queued ${operation} retires its reservation without blocking a fresh task call`, async () => {
    const f = fixture(operation === 'launch' ? { platform: 'darwin' } : {});
    const entered = deferred();
    const pending = deferred();
    let held = false;
    f.beforeCall(async (name) => {
      if (name === 'list_apps' && !held) {
        held = true;
        entered.resolve();
        await pending.promise;
      }
    });
    const holdingQueue = f.backend.listApps!(signal());
    await entered.promise;
    const invoke = () =>
      operation === 'observe'
        ? f.observe()
        : f.backend.launchApp!({ app: 'Fixture' }, signal(), context);
    const cancelled = assert.rejects(invoke(), /aborted/);
    f.backend.clearSession!(context.sessionId);
    const fresh = invoke();
    pending.resolve();
    await holdingQueue;
    await cancelled;
    await fresh;
    assert.equal(f.calls.filter((c) => c.name === 'start_session').length, 1);
    assert.equal(f.calls.filter((c) => c.name === 'end_session').length, 0);
    assert.equal(
      f.calls.filter(
        (c) => c.name === (operation === 'observe' ? 'get_window_state' : 'launch_app'),
      ).length,
      1,
    );
    f.backend.clearSession!(context.sessionId);
    await f.backend.dispose();
    assert.equal(f.calls.filter((c) => c.name === 'end_session').length, 1);
  });
}

test('screen lock at dispatch refuses input and preserves the unconsumed observation', async () => {
  let locked = false;
  const f = fixture({ screenLocked: () => locked });
  const observed = await f.observe();
  const action = {
    type: 'click_element' as const,
    observationId: observed.observationId,
    elementId: observed.elements[0].elementId,
  };
  locked = true;
  const refused = await f.backend.runSemantic!(action, signal(), context);
  assert.equal(refused.outcome.ok, false);
  if (!refused.outcome.ok) assert.equal(refused.outcome.error, 'screen_locked');
  assert.equal(f.calls.filter((c) => c.name === 'click').length, 0);
  locked = false;
  assert.equal((await f.backend.runSemantic!(action, signal(), context)).outcome.ok, true);
  await f.backend.dispose();
});

test('launch is fenced when the session ends immediately before native admission', async () => {
  const f = fixture({
    platform: 'darwin',
    screenLocked: () => {
      // Clear after the outer check but before call() resumes its driver await.
      queueMicrotask(() => queueMicrotask(() => f.backend.clearSession!(context.sessionId)));
      return false;
    },
  });
  await assert.rejects(f.backend.launchApp!({ app: 'Fixture' }, signal(), context), /aborted/);
  await f.backend.dispose();
  assert.equal(f.calls.filter((c) => c.name === 'launch_app').length, 0);
});

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform} recent input only defers foreground and permits fresh-observation recovery`, async () => {
    let active = true;
    const f = fixture({ platform, physicalInputRecentlyActive: () => active });
    const observed = await f.observe();
    const background = await f.backend.runSemantic!(
      {
        type: 'double_click_element',
        observationId: observed.observationId,
        elementId: observed.elements[0].elementId,
      },
      signal(),
      context,
    );
    assert.equal(background.outcome.ok, true);
    const foreground = {
      type: 'click_element' as const,
      delivery: 'foreground' as const,
      observationId: background.observation!.observationId,
      elementId: background.observation!.elements[0].elementId,
    };
    const authorized = { ...context, foregroundAuthorized: true };
    const refused = await f.backend.runSemantic!(foreground, signal(), authorized);
    assert.equal(refused.outcome.ok, false);
    if (!refused.outcome.ok) assert.equal(refused.outcome.error, 'user_intervened');
    assert.equal(refused.outcome.evidence?.path, 'none');
    assert.equal(f.calls.filter((call) => call.name === 'click').length, 0);
    active = false;
    const fresh = await f.observe();
    f.setDelivery('foreground');
    const resumed = await f.backend.runSemantic!(
      { ...foreground, observationId: fresh.observationId, elementId: fresh.elements[0].elementId },
      signal(),
      authorized,
    );
    assert.equal(resumed.outcome.ok, true);
    assert.equal(f.calls.filter((call) => call.name === 'click').length, 1);
    await f.backend.dispose();
  });
}

test('background macOS launch does not query unrelated recent input', async () => {
  const f = fixture({
    platform: 'darwin',
    physicalInputRecentlyActive: () => assert.fail('background launch must not query global idle'),
  });
  await f.backend.launchApp!({ app: 'Fixture' }, signal(), context);
  assert.equal(f.calls.filter((call) => call.name === 'launch_app').length, 1);
  await f.backend.dispose();
});

test('launch cleared after native admission reports unknown and drains before disposal', async () => {
  const f = fixture({ platform: 'darwin' });
  const entered = deferred();
  const pending = deferred();
  f.beforeCall(async (name) => {
    if (name === 'launch_app') {
      entered.resolve();
      await pending.promise;
    }
  });
  const launching = f.backend.launchApp!({ app: 'Fixture' }, signal(), context);
  const rejected = assert.rejects(launching, /outcome_unknown/);
  await entered.promise;
  f.backend.clearSession!(context.sessionId);
  assert.equal(f.calls.filter((c) => c.name === 'end_session').length, 0);
  pending.resolve();
  await rejected;
  await f.backend.dispose();
  assert.equal(f.calls.filter((c) => c.name === 'launch_app').length, 1);
  assert.equal(f.calls.filter((c) => c.name === 'end_session').length, 1);
});

test('explicit native refusal preserves snapshot; missing route consumes it as unknown', async () => {
  const f = fixture();
  const observed = await f.observe();
  const action = {
    type: 'click_element' as const,
    observationId: observed.observationId,
    elementId: observed.elements[0].elementId,
  };
  f.setEffect('refused');
  const refused = await f.backend.runSemantic!(action, signal(), context);
  assert.equal(refused.outcome.evidence?.path, 'none');
  f.setEffect('confirmed');
  f.setRoute(undefined);
  const unknown = await f.backend.runSemantic!(action, signal(), context);
  if (unknown.outcome.ok) assert.fail('missing native route must not imply success');
  assert.equal(unknown.outcome.error, 'outcome_unknown');
  assert.notEqual(unknown.outcome.evidence?.path, 'none');
  const stale = await f.backend.runSemantic!(action, signal(), context);
  if (stale.outcome.ok) assert.fail('uncertain action consumed its snapshot');
  assert.equal(stale.outcome.error, 'stale_frame');
  assert.equal(f.calls.filter((c) => c.name === 'click').length, 2);
  await f.backend.dispose();
});

test('metadata failure releases native resources and prevents dispatch', async () => {
  const f = fixture();
  f.port.metadata = async () => {
    throw new Error('incompatible ABI');
  };
  await assert.rejects(f.observe(), /service_unavailable/);
  assert.equal(f.destroyed(), true);
  assert.equal(f.calls.length, 0);
  await f.backend.dispose();
});

test('unsupported menu expansion is rejected before starting a native observation', async () => {
  const f = fixture();
  await assert.rejects(
    f.backend.observeApp!(
      { app: 'Fixture', includeScreenshot: false, menu: 'File' },
      signal(),
      context,
    ),
    /unsupported_action/,
  );
  assert.equal(f.calls.length, 0);
  await f.backend.dispose();
});

test('model schema excludes old executor actions and unsupported window actions', () => {
  const f = fixture();
  const [tool] = buildComputerUseTools({ backend: f.backend });
  const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
  assert.equal(schema.safeParse({ action: 'select_text' }).success, false);
  assert.equal(
    schema.safeParse({ action: 'type', observation_id: 'o', element_id: 'e', text: 'Paragraph' })
      .success,
    true,
  );
  assert.equal(
    schema.safeParse({ action: 'window_action', window_action: 'minimize' }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ action: 'window_action', window_action: 'move', position: [1, 2] }).success,
    true,
  );
});

test('macOS discovers owned AX sheets and rechecks the exact window before observing it', async () => {
  let open = true;
  const requests: number[] = [];
  const f = fixture({
    platform: 'darwin',
    listOwnedWindows: async (pid: number) => {
      requests.push(pid);
      return open
        ? [
            {
              pid,
              windowId: 8,
              title: 'Save document',
              x: 10,
              y: 20,
              width: 400,
              height: 300,
              role: 'AXSheet' as const,
            },
          ]
        : [];
    },
  });
  const apps = await f.backend.listApps!(signal());
  assert.deepEqual(apps[0].windows, [
    { windowId: 7, title: 'Counter' },
    { windowId: 8, title: 'Save document' },
  ]);
  const observed = await f.backend.observeApp!(
    { app: '42', windowId: 8, includeScreenshot: false },
    signal(),
    context,
  );
  assert.equal(observed.windowId, 8);
  assert.equal(observed.pid, 42);
  assert.equal(observed.elements.length, 1);
  assert.equal(observed.presentationVisibility, 'unavailable');
  assert.ok(requests.length > 0 && requests.every((pid) => pid === 42));
  open = false;
  await assert.rejects(
    f.backend.observeApp!({ app: '42', windowId: 8, includeScreenshot: false }, signal(), context),
    { code: 'target_missing' },
  );
  await f.backend.dispose();
});

test('owned-window discovery cannot admit a different process or a non-window AX role', async () => {
  for (const candidate of [
    { pid: 99, role: 'AXWindow' },
    { pid: 42, role: 'AXMenu' },
  ]) {
    const f = fixture({
      platform: 'darwin',
      listOwnedWindows: async () =>
        [
          {
            ...candidate,
            windowId: 8,
            title: 'Unrelated',
            x: 10,
            y: 20,
            width: 100,
            height: 100,
          },
        ] as never,
    });
    await assert.rejects(
      f.backend.observeApp!(
        { app: '42', windowId: 8, includeScreenshot: false },
        signal(),
        context,
      ),
      { code: 'service_mismatch' },
    );
    assert.equal(
      f.calls.some((call) => call.name === 'get_window_state'),
      false,
    );
    await f.backend.dispose();
  }
});

test('Windows owned dialogs remain discoverable without a title and capture must still prove their exact HWND', async () => {
  const f = fixture({
    platform: 'win32',
    listOwnedWindows: async (pid) => [
      { pid, windowId: 8, title: '', x: 20, y: 30, width: 300, height: 200, role: 'dialog' },
    ],
  });
  const apps = await f.backend.listApps!(signal());
  assert.ok(apps[0].windows?.some((window) => window.windowId === 8 && window.title === ''));
  const observed = await f.backend.observeApp!(
    { app: '42', windowId: 8, includeScreenshot: false },
    signal(),
    context,
  );
  assert.equal(observed.windowId, 8);
  assert.equal(observed.presentationVisibility, 'unavailable');
  const native = f.port.callTool;
  f.port.callTool = async (name, args) => {
    const result = await native(name, args);
    return name === 'get_window_state'
      ? {
          ...result,
          structuredJson: JSON.stringify({ ...JSON.parse(result.structuredJson!), window_id: 7 }),
        }
      : result;
  };
  await assert.rejects(
    f.backend.observeApp!({ app: '42', windowId: 8, includeScreenshot: false }, signal(), context),
    { code: 'target_mismatch' },
  );
  await f.backend.dispose();
});

test('a partially delivered type call retains unknown metadata and cannot replay its old observation', async () => {
  const f = fixture({ platform: 'win32' });
  f.setPermissions({ uia: true });
  f.setEffect('partial');
  f.setRoute('synthetic_events');
  f.setDelivery('foreground');
  const [tool] = buildComputerUseTools({ backend: f.backend, foregroundAuthorized: () => true });
  const runtimeContext = { ...context, cwd: '/tmp', abortSignal: signal(), emitOutput() {} };
  const observed = (await tool.impl({ action: 'observe', app: 'Fixture' }, runtimeContext)) as {
    text: string;
  };
  const call = {
    action: 'type',
    observation_id: JSON.parse(observed.text).observation_id,
    element_id: 's1:1',
    text: 'Do not duplicate this paragraph.',
    delivery: 'foreground',
  };
  const result = (await tool.impl(call, { ...runtimeContext, toolCallId: 'type-unknown' })) as {
    error?: string;
    computerUse?: { target?: { label?: string }; outcome: { execution: string; error?: string } };
  };
  assert.equal(result.error, 'outcome_unknown');
  assert.equal(result.computerUse?.target?.label, 'Increment');
  assert.equal(result.computerUse?.outcome.execution, 'attempted');
  assert.equal(result.computerUse?.outcome.error, 'outcome_unknown');
  assert.doesNotMatch(JSON.stringify(result.computerUse), /Do not duplicate/);
  const replay = (await tool.impl(call, { ...runtimeContext, toolCallId: 'type-replay' })) as {
    error?: string;
  };
  assert.ok(replay.error);
  assert.equal(f.calls.filter((entry) => entry.name === 'type_text').length, 1);
  await f.backend.dispose();
});

test('other task cannot consume a snapshot and a newer window read invalidates the old owner', async () => {
  const f = fixture();
  const first = await f.observe();
  const action = {
    type: 'click_element' as const,
    observationId: first.observationId,
    elementId: first.elements[0].elementId,
  };
  assert.equal(
    (await f.backend.runSemantic!(action, signal(), { ...context, sessionId: 'task-b' })).outcome
      .ok,
    false,
  );
  await f.observe('task-b');
  assert.equal((await f.backend.runSemantic!(action, signal(), context)).outcome.ok, false);
  assert.equal(f.calls.filter((c) => c.name === 'click').length, 0);
  await f.backend.dispose();
});

test('cancelled native action keeps the device queue until settled and reports unknown', async () => {
  const f = fixture();
  const first = await f.observe();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setBlock(async () => {
    started();
    await pending;
  });
  const abort = new AbortController();
  const action = f.backend.runSemantic!(
    {
      type: 'click_element',
      observationId: first.observationId,
      elementId: first.elements[0].elementId,
    },
    abort.signal,
    context,
  );
  await entered;
  abort.abort();
  let observed = false;
  const next = f.observe('task-b').then(() => {
    observed = true;
  });
  await Promise.resolve();
  assert.equal(observed, false);
  release();
  const result = await action;
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) {
    assert.equal(result.outcome.error, 'outcome_unknown');
    assert.notEqual(result.outcome.evidence?.path, 'none');
  }
  await next;
  await f.backend.dispose();
});

test('Linux preflight requires a display and AT-SPI without Mac prompt arguments', async () => {
  const f = fixture({ platform: 'linux' });
  f.setPermissions({ x11: true, atspi: false });
  const noAccessibility = await f.backend.preflight(signal());
  assert.equal(noAccessibility.accessibility, false);
  assert.equal(noAccessibility.screenRecording, true);
  assert.match(noAccessibility.accessibilityGuidance!, /AT-SPI/);
  assert.equal(f.backend.executorState().environmentReady, false);
  f.setPermissions({ x11: false, atspi: true, wayland: true, wayland_enabled: false });
  const noDisplay = await f.backend.preflight(signal());
  assert.equal(noDisplay.accessibility, false);
  assert.equal(noDisplay.screenRecording, false);
  assert.match(noDisplay.screenRecordingGuidance!, /Linux display/);
  f.setPermissions({ x11: true, atspi: true });
  assert.deepEqual(await f.backend.preflight(signal()), {
    accessibility: true,
    screenRecording: true,
  });
  assert.equal(f.backend.executorState().environmentReady, true);
  assert.deepEqual(f.calls.find((c) => c.name === 'check_permissions')?.args, {});
  const observed = await f.observe();
  assert.equal(observed.elements[0].role, 'push_button');
  assert.ok(!f.backend.supportedActions?.includes('secondary_action'));
  await f.backend.dispose();
});

for (const platform of ['linux', 'win32'] as const) {
  test(`${platform} binds targets and background delivery for value and key operations`, async () => {
    const f = fixture({ platform });
    assert.ok(!f.backend.supportedActions?.includes('launch_app'));
    await assert.rejects(
      f.backend.launchApp!({ app: 'Fixture' }, signal(), context),
      /unsupported_action/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.backend.requestAccessibilityPermission, undefined);
    f.setPermissions({ uia: true, integrity_level: 'Medium', x11: true, atspi: true });
    assert.equal((await f.backend.preflight(signal())).accessibility, true);
    const observed = await f.observe();
    const result = await f.backend.runSemantic!(
      {
        type: 'set_value',
        observationId: observed.observationId,
        elementId: observed.elements[0].elementId,
        value: '玛卡',
      },
      signal(),
      context,
    );
    assert.ok(result.outcome.ok);
    const after = result.observation!;
    await f.backend.runSemantic!(
      {
        type: 'press_key',
        observationId: after.observationId,
        elementId: after.elements[0].elementId,
        key: 'super+shift+a',
      },
      signal(),
      context,
    );
    const calls = f.calls.filter((c) => ['set_value', 'press_key'].includes(c.name));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.args.delivery_mode, 'background');
      assert.equal(call.args.pid, 42);
      assert.equal(call.args.window_id, 7);
      assert.ok(call.args.element_token);
    }
    assert.deepEqual(calls[1].args.modifiers, [platform === 'win32' ? 'win' : 'super', 'shift']);
    await f.backend.dispose();
  });
}

test('partial execution is not represented as successful completion or zero input', async () => {
  const f = fixture();
  const first = await f.observe();
  f.setEffect('partial');
  const result = await f.backend.runSemantic!(
    {
      type: 'click_element',
      observationId: first.observationId,
      elementId: first.elements[0].elementId,
    },
    signal(),
    context,
  );
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) assert.equal(result.outcome.error, 'outcome_unknown');
  await f.backend.dispose();
});

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform} text input stays token-bound, requires foreground authority, and retires the old observation`, async () => {
    const f = fixture({ platform });
    const observed = await f.observe();
    const action = {
      type: 'type' as const,
      observationId: observed.observationId,
      elementId: observed.elements[0].elementId,
      elementIdentity: observed.elements[0].identity,
      text: 'First paragraph.\n第二段。',
      delivery: 'foreground' as const,
    };
    assert.ok(f.backend.supportedActions?.includes('type'));
    assert.ok(f.backend.supportedForegroundActions?.includes('type'));
    const denied = await f.backend.runSemantic!(action, signal(), context);
    assert.equal(denied.outcome.ok, false);
    if (!denied.outcome.ok) assert.equal(denied.outcome.error, 'policy_denied');
    assert.equal(
      f.calls.some((call) => call.name === 'type_text'),
      false,
    );
    const missing = await f.backend.runSemantic!(
      { ...action, elementId: undefined, elementIdentity: undefined } as never,
      signal(),
      {
        ...context,
        foregroundAuthorized: true,
      },
    );
    assert.equal(missing.outcome.ok, false);
    if (!missing.outcome.ok) assert.equal(missing.outcome.error, 'target_missing');
    f.setRoute('synthetic_events');
    f.setDelivery('foreground');
    f.setEffect('unverifiable');
    const result = await f.backend.runSemantic!(action, signal(), {
      ...context,
      foregroundAuthorized: true,
    });
    assert.equal(result.outcome.ok, true);
    if (result.outcome.ok) assert.equal(result.outcome.verified, false);
    assert.equal(result.outcome.evidence?.effect, 'unverifiable');
    const typed = f.calls.filter((call) => call.name === 'type_text');
    assert.equal(typed.length, 1);
    assert.deepEqual(typed[0].args, {
      session: typed[0].args.session,
      pid: 42,
      window_id: 7,
      element_token: action.elementId,
      text: action.text,
      delivery_mode: 'foreground',
    });
    const replay = await f.backend.runSemantic!(action, signal(), {
      ...context,
      foregroundAuthorized: true,
    });
    assert.equal(replay.outcome.ok, false);
    if (!replay.outcome.ok) assert.equal(replay.outcome.error, 'stale_frame');
    assert.equal(f.calls.filter((call) => call.name === 'type_text').length, 1);
    await f.backend.dispose();
  });
  for (const actionType of ['click_element', 'double_click_element'] as const) {
    test(`${platform} foreground ${actionType} requires trusted authority and reports native delivery`, async () => {
      const f = fixture({ platform });
      const observed = await f.observe();
      const action = {
        type: actionType,
        observationId: observed.observationId,
        elementId: observed.elements[0].elementId,
        delivery: 'foreground' as const,
      };
      const denied = await f.backend.runSemantic!(action, signal(), context);
      assert.equal(denied.outcome.ok, false);
      if (!denied.outcome.ok) assert.equal(denied.outcome.error, 'policy_denied');
      assert.equal(
        f.calls.some((call) => call.name === 'click' || call.name === 'double_click'),
        false,
      );
      f.setRoute('synthetic_events');
      f.setDelivery('foreground');
      const allowed = await f.backend.runSemantic!(action, signal(), {
        ...context,
        foregroundAuthorized: true,
      });
      assert.equal(allowed.outcome.ok, true);
      if (allowed.outcome.ok) {
        assert.equal(allowed.outcome.tier, 'semantic-foreground');
        assert.equal(allowed.outcome.evidence?.requestedDelivery, 'foreground');
        assert.equal(allowed.outcome.evidence?.actualDelivery, 'foreground');
      }
      const nativeTool = actionType === 'double_click_element' ? 'double_click' : 'click';
      const calls = f.calls.filter((call) => call.name === nativeTool);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args.delivery_mode, 'foreground');
      assert.equal(calls[0].args.element_token, action.elementId);
      assert.equal(calls[0].args.window_id, 7);
      await f.backend.dispose();
    });
  }
}

test('foreground authority is rechecked after asynchronous guards without consuming the frame', async () => {
  let authorized = true;
  let guard: (() => Promise<boolean>) | undefined;
  const entered = deferred();
  const release = deferred();
  const f = fixture({
    foregroundAuthorized: () => authorized,
    screenLocked: () => guard?.() ?? false,
  });
  const observed = await f.observe();
  const action = {
    type: 'click_element' as const,
    observationId: observed.observationId,
    elementId: observed.elements[0].elementId,
    delivery: 'foreground' as const,
  };
  guard = async () => {
    entered.resolve();
    await release.promise;
    return false;
  };
  const pending = f.backend.runSemantic!(action, signal(), {
    ...context,
    foregroundAuthorized: true,
  });
  await entered.promise;
  authorized = false;
  release.resolve();
  const denied = await pending;
  assert.equal(denied.outcome.ok, false);
  if (!denied.outcome.ok) assert.equal(denied.outcome.error, 'policy_denied');
  assert.equal(
    f.calls.some((call) => call.name === 'click'),
    false,
  );
  guard = undefined;
  authorized = true;
  const allowed = await f.backend.runSemantic!(action, signal(), {
    ...context,
    foregroundAuthorized: true,
  });
  assert.equal(allowed.outcome.ok, true);
  assert.equal(allowed.outcome.evidence?.requestedDelivery, 'foreground');
  assert.equal(allowed.outcome.evidence?.actualDelivery, 'background');
  await f.backend.dispose();
});

for (const route of ['synthetic_events', 'global_input']) {
  test(`native ${route} foreground cannot be accepted for a background request`, async () => {
    const f = fixture();
    const observed = await f.observe();
    f.setRoute(route);
    f.setDelivery('foreground');
    const result = await f.backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observed.observationId,
        elementId: observed.elements[0].elementId,
      },
      signal(),
      { ...context, foregroundAuthorized: true },
    );
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'outcome_unknown');
    assert.notEqual(result.outcome.evidence?.path, 'none');
    assert.equal(result.outcome.evidence?.requestedDelivery, 'background');
    assert.equal(result.outcome.evidence?.actualDelivery, 'foreground');
    assert.equal(f.calls.filter((call) => call.name === 'click').length, 1);
    await f.backend.dispose();
  });
}

for (const delivery of ['background', 'foreground', 'unknown'] as const) {
  test(`canonical global_input preserves ${delivery} delivery rather than inferring it from the route`, async () => {
    const f = fixture();
    const observed = await f.observe();
    f.setRoute('global_input');
    f.setDelivery(delivery);
    const action = {
      type: 'double_click_element' as const,
      observationId: observed.observationId,
      elementId: observed.elements[0].elementId,
      delivery: delivery === 'foreground' ? ('foreground' as const) : ('background' as const),
    };
    const result = await f.backend.runSemantic!(action, signal(), {
      ...context,
      foregroundAuthorized: true,
    });
    if (delivery === 'unknown') {
      assert.equal(result.outcome.ok, false);
      if (!result.outcome.ok) assert.equal(result.outcome.error, 'outcome_unknown');
      assert.notEqual(result.outcome.evidence?.path, 'none');
      assert.equal(result.observation, undefined);
      const retry = await f.backend.runSemantic!(action, signal(), context);
      assert.equal(retry.outcome.ok, false);
      if (!retry.outcome.ok) assert.equal(retry.outcome.error, 'stale_frame');
    } else {
      assert.equal(result.outcome.ok, true);
      assert.equal(result.outcome.evidence?.actualDelivery, delivery);
      assert.equal(result.outcome.evidence?.path, `${delivery}-input`);
      assert.notEqual(result.observation?.observationId, observed.observationId);
    }
    assert.equal(f.calls.filter((call) => call.name === 'double_click').length, 1);
    await f.backend.dispose();
  });
}

test('macOS element-only readiness does not require screenshot permission', async () => {
  const f = fixture({ platform: 'darwin' });
  f.setPermissions({ accessibility: true, screen_recording: false });
  const readiness = await f.backend.preflight(signal());
  assert.equal(readiness.accessibility, true);
  assert.equal(readiness.screenRecording, false);
  assert.equal(f.backend.executorState().environmentReady, true);
  assert.match(readiness.screenRecordingGuidance!, /quit and reopen/);
  const observation = await f.observe();
  const result = await f.backend.runSemantic!(
    {
      type: 'set_value',
      observationId: observation.observationId,
      elementId: observation.elements[0].elementId,
      value: 'new value',
    },
    signal(),
    context,
  );
  assert.equal(result.outcome.ok, true);
  assert.ok(
    f.calls
      .filter((call) => call.name === 'get_window_state')
      .every((call) => call.args.include_screenshot === false),
  );
  await f.backend.dispose();
});

test('native Wayland geometry refuses before dispatch even when XWayland is also present', async () => {
  const f = fixture({ platform: 'linux' });
  f.setPermissions({ x11: true, wayland: true, wayland_enabled: true, atspi: true });
  await f.backend.preflight(signal());
  const observation = await f.observe();
  const result = await f.backend.runSemantic!(
    {
      type: 'window_action',
      action: 'move',
      observationId: observation.observationId,
      elementId: observation.elements[0].elementId,
      position: { x: 10, y: 10 },
    },
    signal(),
    context,
  );
  assert.equal(result.outcome.ok, false);
  if (!result.outcome.ok) {
    assert.equal(result.outcome.error, 'unsupported_action');
    assert.match(result.outcome.message ?? '', /Wayland/);
  }
  assert.equal(result.outcome.evidence?.path, 'none');
  assert.equal(
    f.calls.some((call) => call.name === 'set_window_frame'),
    false,
  );
  await f.backend.dispose();
});

test('pure accessibility value and geometry actions do not accept foreground delivery on macOS', async () => {
  const f = fixture({ platform: 'darwin' });
  const observed = await f.observe();
  const target = {
    observationId: observed.observationId,
    elementId: observed.elements[0].elementId,
    delivery: 'foreground' as const,
  };
  for (const action of [
    { ...target, type: 'set_value' as const, value: 'test' },
    {
      ...target,
      type: 'window_action' as const,
      action: 'move' as const,
      position: { x: 2, y: 3 },
    },
  ]) {
    const result = await f.backend.runSemantic!(action, signal(), {
      ...context,
      foregroundAuthorized: true,
    });
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'unsupported_action');
  }
  assert.equal(
    f.calls.some((call) => ['set_value', 'set_window_frame'].includes(call.name)),
    false,
  );
  await f.backend.dispose();
});

test('exact-window screenshots survive unavailable accessibility without actionable tokens', async () => {
  for (const reason of [
    'ax_tree_empty: canvas',
    'atspi_tree_empty: canvas',
    'msaa_fallback_partial: the UIA provider was unavailable and Cua Driver used a partial MSAA tree. Treat it as discovery evidence only; it cannot prove checked state.',
  ]) {
    const f = fixture();
    const native = f.port.callTool;
    f.port.callTool = async (name, args) => {
      const result = await native(name, args);
      if (name !== 'get_window_state') return result;
      return {
        ...result,
        structuredJson: JSON.stringify({
          ...JSON.parse(result.structuredJson!),
          degraded: true,
          degraded_reason: reason,
          screenshot_width: 1,
          screenshot_height: 1,
        }),
        images: [
          {
            mimeType: 'image/png',
            dataBase64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=',
          },
        ],
      };
    };
    const observed = await f.backend.observeApp!(
      { app: 'Fixture', includeScreenshot: true },
      signal(),
      context,
    );
    assert.equal(observed.screenshot?.widthPx, 1);
    assert.equal(observed.accessibilityUnavailable, true);
    assert.equal(observed.accessibilityText, undefined);
    assert.deepEqual(observed.elements, []);
    const result = await f.backend.runSemantic!(
      {
        type: 'click_element',
        observationId: observed.observationId,
        elementId: 's1:1',
      },
      signal(),
      context,
    );
    assert.equal(result.outcome.ok, false);
    if (!result.outcome.ok) assert.equal(result.outcome.error, 'target_missing');
    assert.equal(
      f.calls.some((call) => call.name === 'click'),
      false,
    );
    await f.backend.dispose();
  }
});

test('degraded screenshot handling preserves exact-target and capture boundaries', async () => {
  for (const variant of [
    { reason: 'ax_tree_empty: canvas', pid: 43, image: true, error: 'target_mismatch' },
    {
      reason: 'accessibility_window_identity_unproven: app scoped',
      pid: 42,
      image: true,
      error: 'capture_failed',
    },
    { reason: 'ax_tree_empty: canvas', pid: 42, image: false, error: 'capture_failed' },
    { reason: 'msaa_fallback_partial: partial', pid: 43, image: true, error: 'target_mismatch' },
    {
      reason: 'msaa_fallback_partial: partial',
      pid: 42,
      windowId: 8,
      image: true,
      error: 'target_mismatch',
    },
    { reason: 'msaa_fallback_partial: partial', pid: 42, image: false, error: 'capture_failed' },
    {
      reason: 'msaa_fallback_partial: partial',
      pid: 42,
      image: true,
      includeScreenshot: false,
      error: 'capture_failed',
    },
  ]) {
    const f = fixture();
    const native = f.port.callTool;
    f.port.callTool = async (name, args) => {
      const result = await native(name, args);
      if (name !== 'get_window_state') return result;
      return {
        ...result,
        structuredJson: JSON.stringify({
          pid: variant.pid,
          window_id: variant.windowId ?? 7,
          degraded: true,
          degraded_reason: variant.reason,
          elements: [],
          screenshot_width: 1,
          screenshot_height: 1,
        }),
        images: variant.image ? [{ mimeType: 'image/png', dataBase64: 'AA==' }] : [],
      };
    };
    await assert.rejects(
      f.backend.observeApp!(
        { app: 'Fixture', includeScreenshot: variant.includeScreenshot ?? true },
        signal(),
        context,
      ),
      new RegExp(variant.error),
    );
    await f.backend.dispose();
  }
});
