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
import { act, createElement, useLayoutEffect } from 'react';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComputerUsePresentation } from '../../shared/computer-use-presentation.js';
import { createFakeWorkbarServices, useComputerUsePresentation, useComputerUsePreview, WorkbarServicesProvider, ComputerUseStatusView, ComputerUsePanelView } from '../../renderer/features/workbar/testing.js';
import type { ComputerUsePreviewStatus } from '../../shared/computer-use-preview.js';

test('the compact Computer entry uses application artwork without showing a screenshot', async () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = { document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  Object.assign(globalThis, globals);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  let opened = 0;
  const state: ComputerUsePresentation = {
    sessionId: 'a', revision: 1, state: 'running', updatedAt: 1, appName: 'Firefox', action: 'type',
    appIconDataUrl: 'data:image/png;base64,aWNvbg==',
    frame: { base64: 'cGl4ZWxz', mimeType: 'image/png', widthPx: 320, heightPx: 200, capturedAt: 1 },
  };
  try {
    const render = (presentation: ComputerUsePresentation | null) => act(() => root.render(createElement(ComputerUseStatusView, {
      presentation, locale: 'zh-CN', onOpen: () => { opened++; },
    })));
    await render(state);
    const button = document.querySelector('button')!;
    assert.equal(document.querySelectorAll('button').length, 1);
    assert.match(button.getAttribute('aria-label') ?? '', /查看电脑.*Firefox/);
    assert.equal(button.querySelector('img')?.getAttribute('src'), state.appIconDataUrl);
    assert.doesNotMatch(button.innerHTML, /cGl4ZWxz/);
    assert.equal(button.textContent, '', 'the application entry only displays its icon');
    await act(() => { button.dispatchEvent(new window.Event('click', { bubbles: true })); });
    assert.equal(opened, 1);
    await render({ ...state, revision: 2, appIconDataUrl: undefined, state: 'stopped' });
    assert.equal(document.querySelector('img'), null);
    await render(null);
    assert.equal(document.querySelector('button'), null);
  } finally {
    await act(() => root.unmount());
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]!);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('the panel keeps its current snapshot until live video has presented a frame', async () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = { document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  Object.assign(globalThis, globals);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const presentation: ComputerUsePresentation = {
    sessionId: 'a', revision: 1, state: 'running', updatedAt: 1, appName: 'Firefox', action: 'type',
    frame: { base64: 'cGl4ZWxz', mimeType: 'image/png', widthPx: 320, heightPx: 200, capturedAt: 1 },
  };
  try {
    const render = (state: ComputerUsePreviewStatus['state']) => act(() => root.render(createElement(ComputerUsePanelView, {
      presentation, locale: 'zh-CN', previewAvailable: true, preview: { leaseId: 'preview', state },
    })));
    await render('starting');
    assert.ok(document.querySelector('.maka-computer-preview-slot img'));
    assert.equal(document.querySelector('.maka-computer-preview-slot')?.hasAttribute('data-live'), false);
    await render('live');
    assert.equal(document.querySelector('.maka-computer-preview-slot img'), null);
    assert.equal(document.querySelector('.maka-computer-preview-slot')?.hasAttribute('data-live'), true);
    await render('waiting');
    assert.ok(document.querySelector('.maka-computer-preview-slot img'));
    assert.match(document.querySelector('.maka-computer-preview-controls button')?.textContent ?? '', /关闭预览/);
    assert.doesNotMatch(document.querySelector('.maka-computer-preview-controls')?.textContent ?? '', /重新预览/);
    await render('stopped');
    assert.ok(document.querySelector('.maka-computer-preview-slot img'));
  } finally {
    await act(() => root.unmount());
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]!);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('Computer preview never restores revoked or superseded frames across subscriptions', async () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = { document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  Object.assign(globalThis, globals);
  const { createRoot } = await import('react-dom/client');
  const reads: ReturnType<typeof deferred<ComputerUsePresentation | null>>[] = [];
  const listeners: ((state: ComputerUsePresentation | null) => void)[] = [];
  const unsubscriptions: number[] = [];
  let unavailable = false;
  const services = createFakeWorkbarServices({ computerUse: {
    read: () => { const request = deferred<ComputerUsePresentation | null>(); reads.push(request); return request.promise; },
    subscribe: (_id, callback) => {
      if (unavailable) throw new Error('provider disconnected');
      listeners.push(callback);
      const index = listeners.length - 1;
      return () => { unsubscriptions.push(index); };
    },
    stop: async () => {},
  } });
  const commits: string[] = [];
  function Harness(props: { sessionId: string; active: boolean }) {
    const state = useComputerUsePresentation(props.sessionId, props.active);
    const text = state.failed ? 'unavailable' : state.presentation ? `${state.presentation.sessionId}:${state.presentation.revision}` : 'empty';
    useLayoutEffect(() => { commits.push(text); });
    return createElement('output', null, text);
  }
  const root = createRoot(document.getElementById('root')!);
  const render = (sessionId: string, active = true) => root.render(createElement(WorkbarServicesProvider, { services }, createElement(Harness, { sessionId, active })));
  const state = (sessionId: string, revision: number): ComputerUsePresentation => ({ sessionId, revision, state: 'settled', updatedAt: 1 });
  try {
    await act(async () => { render('a'); });
    await act(async () => { listeners[0]!(state('a', 2)); reads[0]!.resolve(state('a', 1)); });
    assert.equal(document.querySelector('output')?.textContent, 'a:2', 'late initial read must not overwrite an event');

    await act(async () => { render('a', false); });
    assert.equal(commits.at(-1), 'empty');
    await act(async () => { render('a'); });
    assert.equal(commits.at(-1), 'empty', 'reopening cannot paint a frame from the closed subscription');
    assert.deepEqual(unsubscriptions, [0]);
    await act(async () => { reads[1]!.resolve(null); });
    assert.equal(document.querySelector('output')?.textContent, 'empty');

    await act(async () => { render('b'); });
    await act(async () => { listeners[1]!(state('a', 9)); reads[2]!.resolve(state('b', 3)); });
    assert.equal(document.querySelector('output')?.textContent, 'b:3', 'late callbacks from a previous task are ignored');

    unavailable = true;
    await act(async () => { render('c'); });
    assert.equal(document.querySelector('output')?.textContent, 'unavailable');
  } finally {
    await act(async () => { root.unmount(); });
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]!);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('Live Computer preview requires a click and fences hidden, superseded and previous-task leases', async () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const globals = { document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  Object.assign(globalThis, globals);
  const querySelectorAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => selector.includes(':popover-open') ? [] : querySelectorAll(selector)) as typeof document.querySelectorAll;
  let hiddenSlot = false;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 20, y: 30, left: 20, top: 30, right: 320, bottom: 230, width: hiddenSlot ? 0 : 300, height: 200, toJSON: () => ({}) });
  class Observer { observe() {} disconnect() {} }
  window.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  window.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const { createRoot } = await import('react-dom/client');
  const starts: { sessionId: string; leaseId: string; result: ReturnType<typeof deferred<ComputerUsePreviewStatus>> }[] = [];
  const stops: string[] = [];
  const listeners: ((value: ComputerUsePreviewStatus) => void)[] = [];
  const services = createFakeWorkbarServices({ computerUsePreview: {
    start: (sessionId, leaseId) => {
      const result = deferred<ComputerUsePreviewStatus>();
      starts.push({ sessionId, leaseId, result });
      return result.promise;
    },
    stop: async (leaseId) => { stops.push(leaseId); },
    updateBounds: async () => {},
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
  } });
  function Harness(props: { sessionId: string; active: boolean }) {
    const preview = useComputerUsePreview(props.sessionId, props.active, true);
    return createElement('section', null,
      createElement('div', { ref: preview.slotRef }),
      createElement('output', null, preview.status?.state ?? 'idle'),
      createElement('button', { onClick: preview.start }, 'start'),
      createElement('button', { onClick: preview.stop }, 'close'));
  }
  const root = createRoot(document.getElementById('root')!);
  const render = (sessionId: string, active = true) => root.render(createElement(WorkbarServicesProvider, { services }, createElement(Harness, { sessionId, active })));
  const click = async (index = 0) => act(async () => { document.querySelectorAll('button')[index]!.click(); });
  try {
    await act(async () => { render('a'); });
    assert.equal(starts.length, 0, 'opening the sidebar cannot start media capture');
    await click();
    const first = starts[0]!;
    assert.equal(document.querySelector('output')?.textContent, 'starting');
    await act(async () => { render('a', false); });
    assert.deepEqual(stops, [first.leaseId], 'hiding revokes even a pending preview');
    await act(async () => {
      first.result.resolve({ leaseId: first.leaseId, state: 'live' });
      listeners[0]!({ leaseId: first.leaseId, state: 'live' });
    });
    assert.equal(document.querySelector('output')?.textContent, 'idle');
    await act(async () => { render('a'); });
    assert.equal(document.querySelector('output')?.textContent, 'idle', 'reopening does not paint a previous live status');

    await click();
    const second = starts[1]!;
    await act(async () => {
      listeners[1]!({ leaseId: second.leaseId, state: 'waiting', reason: 'target_changed' });
      second.result.resolve({ leaseId: second.leaseId, state: 'live' });
    });
    assert.equal(document.querySelector('output')?.textContent, 'waiting', 'a late start answer cannot overwrite an authoritative event');
    await act(async () => { listeners[1]!({ leaseId: second.leaseId, state: 'live' }); });
    assert.equal(document.querySelector('output')?.textContent, 'live');
    assert.equal(starts.length, 2, 'main resumes the existing request without another renderer start');
    await act(async () => { listeners[1]!({ leaseId: second.leaseId, state: 'waiting', reason: 'target_changed' }); });
    await act(async () => {
      hiddenSlot = true;
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame(1);
    });
    hiddenSlot = false;
    assert.ok(stops.includes(second.leaseId), 'the mounted waiting-state watcher revokes a hidden slot');
    await act(async () => { listeners[1]!({ leaseId: second.leaseId, state: 'live' }); });
    assert.equal(document.querySelector('output')?.textContent, 'stopped', 'closed intent rejects late resume events');
    await click();
    const third = starts[2]!;
    await act(async () => {
      listeners[1]!({ leaseId: second.leaseId, state: 'live' });
      third.result.resolve({ leaseId: third.leaseId, state: 'live' });
    });
    assert.equal(document.querySelector('output')?.textContent, 'live');
    await act(async () => { render('b'); });
    assert.equal(document.querySelector('output')?.textContent, 'idle');
    assert.ok(stops.includes(third.leaseId), 'switching tasks revokes the old preview');
    await act(async () => { listeners[1]!({ leaseId: third.leaseId, state: 'live' }); });
    assert.equal(document.querySelector('output')?.textContent, 'idle');
    await click();
    assert.equal(starts[3]!.sessionId, 'b');
    await click(1);
    assert.ok(stops.includes(starts[3]!.leaseId));
    assert.equal(document.querySelector('output')?.textContent, 'stopped');
  } finally {
    await act(async () => { root.unmount(); });
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]!);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
