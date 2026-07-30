import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  LlmConnection,
  SessionEvent,
  SessionHeader,
  StoredMessage,
  ToolInvocationRecord,
} from '@maka/core';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

test('Computer Use snapshots execution args and persists only the privacy summary', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const invocations: ToolInvocationRecord[] = [];
  const observedImplArgs: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    recordToolInvocation: (record) => {
      invocations.push(record);
    },
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    impl: async (args) => {
      await gate;
      observedImplArgs.push(args);
      return { ok: true };
    },
  };
  const args = {
    action: 'type',
    app: 'Example',
    observation_id: 'frame-1',
    text: 'secret text',
    coordinate: [123, 456],
  };
  const execution = runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    input: args,
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  args.app = 'Mutated';
  args.observation_id = 'frame-999';
  args.text = 'changed secret';
  args.coordinate[0] = 999;
  release();
  await execution;

  assert.deepEqual(observedImplArgs, [
    {
      action: 'type',
      app: 'Example',
      observation_id: 'frame-1',
      text: 'secret text',
      coordinate: [123, 456],
    },
  ]);
  const expectedSummary = {
    action: 'type',
    approvalClass: 'keyboard_mutation',
    rememberForTurnAllowed: true,
    app: 'Example',
    observationId: 'frame-1',
  };
  const call = messages.find((message) => message.type === 'tool_call');
  assert.deepEqual(call?.type === 'tool_call' ? call.args : undefined, expectedSummary);
  const start = events.find((event) => event.type === 'tool_start');
  assert.deepEqual(start?.type === 'tool_start' ? start.args : undefined, expectedSummary);
  assert.equal(invocations.length, 1);
  assert.match(invocations[0]!.argsSummary ?? '', /keyboard_mutation/);
  assert.doesNotMatch(invocations[0]!.argsSummary ?? '', /secret|123|456/);
});

test('the model reads its own call back in the names the tool accepts', async () => {
  // The record replayed to the model used to be the host's approval
  // projection: `approvalClass`, `rememberForTurnAllowed`, `windowId`. Two of
  // those are not arguments at all and the third is a key the tool rejects, so
  // the model went on calling it that way — six of eleven calls on a real
  // desktop run, and 29 rejections in this machine's telemetry.
  const events: SessionEvent[] = [];
  const runtimeEvents: unknown[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    getCurrentRunId: () => 'run-1',
    runtimeCommitSink: {
      commitToolPrepared: async (input) => {
        runtimeEvents.push(input.runtimeEvent);
        return { status: 'committed' as const, created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => ({
        status: 'committed' as const,
        created: true,
        runtimeEventSeq: 2,
      }),
    },
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    impl: async () => ({ ok: true }),
  };
  await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    input: {
      action: 'click_element',
      app: 'Example',
      window_id: 12747,
      observation_id: 'frame-1',
      element_id: '7',
    },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });
  const call = runtimeEvents.find(
    (event) => (event as { content?: { kind?: string } }).content?.kind === 'function_call',
  ) as { content: { args: Record<string, unknown> } } | undefined;
  assert.deepEqual(call?.content.args, {
    action: 'click_element',
    app: 'Example',
    window_id: 12747,
    observation_id: 'frame-1',
    element_id: '7',
  });
});

test('Computer Use validation failures still persist a redacted call and result', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const invocations: ToolInvocationRecord[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    recordToolInvocation: (record) => {
      invocations.push(record);
    },
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    permissionArgs: () => {
      throw new Error('AX label: Customer SSN 123-45-6789');
    },
    impl: async () => {
      assert.fail('invalid arguments must not reach the implementation');
    },
  };

  const { result } = await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-invalid',
    input: {
      action: 'type',
      text: 'private text',
      coordinate: [123, 456],
    },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  assert.equal((result as { error?: string }).error, 'Computer Use arguments failed validation');
  const serialized = JSON.stringify({ messages, events, invocations });
  assert.doesNotMatch(serialized, /Customer SSN|123-45-6789|private text|123|456/);
  assert.equal(
    messages.some((message) => message.type === 'tool_call'),
    true,
  );
  assert.equal(
    messages.some((message) => message.type === 'tool_result'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_start'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_result'),
    true,
  );
  assert.equal(invocations[0]?.errorClass, 'InvalidArguments');
});

function nextId(): () => string {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.invalid',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
