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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractionRecord, StoredInteractionRequest } from '@maka/storage/interaction-store';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeInteractionSnapshot,
  decodeSessionInteractionProjection,
  HOST_OPERATION_SPECS,
  INTERACTION_MAX_PENDING_PER_SESSION,
} from '../protocol/index.js';
import {
  answerOutcome,
  projectInteractionRecord,
  projectSessionInteractions,
} from '../server/interaction-projection.js';
import {
  authorizeRuntimeHostOperation,
  createRuntimeHostConnectionAuthority,
  LOCAL_OWNER_CONNECTION_AUTHORITY,
} from '../server/connection-authority.js';
import {
  CAPABILITY_PROVIDER_OPERATION_GRANTS,
  SESSION_GUEST_OPERATION_GRANTS,
} from '../server/access-credential-store.js';

describe('Runtime Host Interaction protocol', () => {
  test('text authorization has exact bounded wire input and owner-only operation grants', () => {
    const frame = {
      requestId: 'text-answer-1',
      operation: 'interaction.respondByText',
      input: { sessionId: 'session-1', interactionId: 'interaction-1', text: '批准' },
    } as const;
    assert.deepEqual(decodeClientFrame(frame), frame);
    for (const input of [
      { ...frame.input, decision: 'allow' },
      { ...frame.input, text: '批'.repeat(342) },
      { ...frame.input, interactionId: 'invalid:id' },
    ])
      assert.throws(() => decodeClientFrame({ ...frame, input }), isInvalidFrame);
    for (const kind of ['unrecognized', 'unavailable']) {
      const response = {
        requestId: frame.requestId,
        operation: frame.operation,
        ok: true,
        result: { kind },
      };
      assert.deepEqual(decodeHostFrame(response), response);
      assert.throws(
        () => decodeHostFrame({ ...response, result: { kind, decision: 'allow' } }),
        isInvalidFrame,
      );
    }
    assert.equal(authorizeRuntimeHostOperation(LOCAL_OWNER_CONNECTION_AUTHORITY, frame), true);
    for (const [principalKind, operationGrants] of [
      ['session_guest', SESSION_GUEST_OPERATION_GRANTS],
      ['capability_provider', CAPABILITY_PROVIDER_OPERATION_GRANTS],
    ] as const) {
      const authority = createRuntimeHostConnectionAuthority({
        principalKind,
        principalId: 'test-principal',
        credentialId: 'test-credential',
        operationGrants,
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
      });
      assert.equal(authorizeRuntimeHostOperation(authority, frame), false);
    }
    const restrictedOwner = createRuntimeHostConnectionAuthority({
      principalKind: 'remote_owner',
      principalId: 'remote-owner',
      credentialId: 'remote-credential',
      operationGrants: ['interaction.answer'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    assert.equal(authorizeRuntimeHostOperation(restrictedOwner, frame), false);
    const remoteOwner = createRuntimeHostConnectionAuthority({
      ...restrictedOwner,
      operationGrants: ['interaction.respondByText'],
    });
    assert.equal(authorizeRuntimeHostOperation(remoteOwner, frame), true);
  });

  test('text authorization output carries the original reply only on a canonical decision', () => {
    const snapshot = {
      ...snapshotBase('interaction-1'),
      revision: 2,
      status: 'answered',
      request: {
        kind: 'client_capability',
        toolUseId: 'tool-1',
        target: {
          providerId: 'provider-1',
          contractId: 'contract-1',
          serverId: 'desktop_computer_use',
          toolName: 'computer',
          capability: 'computer_use',
          scope: { kind: 'capability' },
        },
      },
      outcome: {
        kind: 'client_capability_decision',
        decision: 'allow',
        committedAt: 5,
        responseText: '批准',
      },
    } as const;
    const response = {
      requestId: 'text-1',
      operation: 'interaction.respondByText',
      ok: true,
      result: { kind: 'answered', snapshot },
    } as const;
    assert.deepEqual(decodeHostFrame(response), response);
    assert.throws(
      () =>
        decodeInteractionSnapshot({
          ...snapshot,
          outcome: { ...snapshot.outcome, responseText: '批'.repeat(342) },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['interaction.respondByText'].assertOutputForInput?.(
          { sessionId: 'session-1', interactionId: 'other-request', text: '批准' },
          response.result,
        ),
      isInvalidFrame,
    );
  });

  test('decodes a closed snapshot and rejects extra fields', () => {
    const closed = {
      ...snapshotBase('interaction-1'),
      revision: 2,
      status: 'closed',
      outcome: { kind: 'closure', reason: 'turn_stopped', committedAt: 5 },
    } as const;
    assert.deepEqual(decodeInteractionSnapshot(closed), closed);
    assert.throws(
      () => decodeInteractionSnapshot({ ...closed, privateState: true }),
      isInvalidFrame,
    );
  });

  test('accepts only a bounded pending-only Session projection', () => {
    const pending = Array.from({ length: INTERACTION_MAX_PENDING_PER_SESSION }, (_, index) => ({
      ...snapshotBase(`interaction-${index}`),
      revision: 1,
      status: 'pending',
      outcome: null,
    }));
    assert.deepEqual(decodeSessionInteractionProjection({ pending }, 'session-1'), { pending });
    assert.throws(
      () =>
        decodeSessionInteractionProjection(
          {
            pending: [
              ...pending,
              {
                ...snapshotBase('interaction-overflow'),
                revision: 1,
                status: 'pending',
                outcome: null,
              },
            ],
          },
          'session-1',
        ),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeSessionInteractionProjection(
          {
            pending: [
              {
                ...snapshotBase('interaction-closed'),
                revision: 2,
                status: 'closed',
                outcome: { kind: 'closure', reason: 'turn_terminal', committedAt: 6 },
              },
            ],
          },
          'session-1',
        ),
      isInvalidFrame,
    );
  });

  test('routes query and answer with their exact ready operation declarations', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'query-1',
        operation: 'interaction.query',
        input: { sessionId: 'session-1', interactionId: 'interaction-1' },
      }),
      {
        requestId: 'query-1',
        operation: 'interaction.query',
        input: { sessionId: 'session-1', interactionId: 'interaction-1' },
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'answer-1',
        operation: 'interaction.answer',
        input: {
          sessionId: 'session-1',
          interactionId: 'interaction-1',
          answer: { kind: 'question', answers: ['Yes'] },
        },
      }),
      {
        requestId: 'answer-1',
        operation: 'interaction.answer',
        input: {
          sessionId: 'session-1',
          interactionId: 'interaction-1',
          answer: { kind: 'question', answers: ['Yes'] },
        },
      },
    );

    assert.deepEqual(operationDeclaration('interaction.query'), {
      mode: 'query',
      availability: 'ready',
      errors: [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'not_found',
        'internal_failure',
      ],
    });
    assert.deepEqual(operationDeclaration('interaction.answer'), {
      mode: 'command',
      availability: 'ready',
      errors: [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'not_found',
        'operation_conflict',
        'already_resolved',
        'internal_failure',
      ],
    });
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'answer-1',
        operation: 'interaction.answer',
        ok: false,
        error: { code: 'already_resolved', message: 'Interaction already resolved' },
      }),
      {
        requestId: 'answer-1',
        operation: 'interaction.answer',
        ok: false,
        error: { code: 'already_resolved', message: 'Interaction already resolved' },
      },
    );
  });

  test('decodes a form snapshot and exact form answer without widening the wire', () => {
    const snapshot = {
      schemaVersion: 1,
      interactionId: 'form-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'form',
        toolUseId: 'tool-1',
        message: 'Choose settings',
        requester: { name: 'deploy', source: 'Example server' },
        fields: [
          {
            kind: 'boolean',
            name: 'confirm',
            label: 'Confirm',
            required: true,
          },
        ],
      },
    } as const;
    assert.deepEqual(decodeInteractionSnapshot(snapshot), snapshot);

    const frame = {
      requestId: 'answer-form',
      operation: 'interaction.answer',
      input: {
        sessionId: 'session-1',
        interactionId: 'form-1',
        answer: { kind: 'form', action: 'accept', values: { confirm: true } },
      },
    } as const;
    assert.deepEqual(decodeClientFrame(frame), frame);
    assert.throws(
      () =>
        decodeClientFrame({
          ...frame,
          input: {
            ...frame.input,
            answer: { ...frame.input.answer, requestState: 'must-not-cross-host-wire' },
          },
        }),
      isInvalidFrame,
    );
  });

  test('returns the canonical winner only for an equivalent normalized answer retry', () => {
    const request = storedRequest('interaction-1', 10);
    const answered: InteractionRecord & { outcome: NonNullable<InteractionRecord['outcome']> } = {
      request,
      outcome: {
        sessionId: request.sessionId,
        turnId: request.turnId,
        runId: request.runId,
        requestId: request.requestId,
        outcome: { kind: 'question_answer', answers: ['Yes'], committedAt: 20 },
      },
    };
    const same = answerOutcome(answered, { kind: 'question', answers: ['Yes'] });
    assert.deepEqual(same, { ok: true, result: projectInteractionRecord(answered) });
    assert.equal(answerOutcome(answered, { kind: 'question', answers: ['No'] }).ok, false);

    const closed = {
      ...answered,
      outcome: {
        ...answered.outcome,
        outcome: { kind: 'closure', reason: 'turn_terminal', committedAt: 21 } as const,
      },
    };
    assert.deepEqual(answerOutcome(closed, { kind: 'question', answers: ['Yes'] }), {
      ok: false,
      error: { code: 'already_resolved', message: 'Interaction was already closed' },
    });

    assert.deepEqual(
      projectSessionInteractions([
        storedRequest('interaction-b', 2),
        storedRequest('interaction-c', 1),
        storedRequest('interaction-a', 2),
      ]).pending.map((snapshot) => snapshot.interactionId),
      ['interaction-c', 'interaction-a', 'interaction-b'],
    );
  });
});

function snapshotBase(interactionId: string) {
  return {
    schemaVersion: 1 as const,
    interactionId,
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    request: questionRequest(),
  };
}

function questionRequest() {
  return {
    kind: 'question' as const,
    toolUseId: 'tool-1',
    questions: [
      {
        question: 'Continue?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
}

function storedRequest(requestId: string, createdAt: number): StoredInteractionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    requestId,
    createdAt,
    request: questionRequest(),
  };
}

function operationDeclaration(operation: 'interaction.query' | 'interaction.answer') {
  const spec = HOST_OPERATION_SPECS[operation];
  return { mode: spec.mode, availability: spec.availability, errors: spec.errors };
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
