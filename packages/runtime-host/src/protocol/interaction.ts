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

import {
  decodeInteractionAnswer as decodeCoreInteractionAnswer,
  decodeInteractionCanonicalOutcome as decodeCoreInteractionCanonicalOutcome,
  decodeInteractionRequest as decodeCoreInteractionRequest,
  isInteractionCanonicalOutcomeValidForRequest,
  INTERACTION_AUTHORIZATION_TEXT_MAX_BYTES,
  type InteractionAnswer,
  type InteractionCanonicalOutcome,
  type InteractionClosureReason,
  type InteractionFormAnswer,
  type InteractionFormField,
  type InteractionFormRequest,
  type InteractionFormResult,
  type InteractionFormValue,
  type InteractionPermissionAnswer,
  type InteractionPermissionDecisionFields,
  type InteractionPermissionPrompt,
  type InteractionQuestion,
  type InteractionQuestionOption,
  type InteractionRequest,
  type InteractionSandboxBoundaryAnswer,
  type InteractionSandboxBoundaryRequest,
} from '@maka/core/interaction';
import { assertExactKeys, requireEntityId, requireRecord, requireString } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export type {
  InteractionAnswer,
  InteractionCanonicalOutcome,
  InteractionClosureReason,
  InteractionFormAnswer,
  InteractionFormField,
  InteractionFormRequest,
  InteractionFormResult,
  InteractionFormValue,
  InteractionPermissionAnswer,
  InteractionPermissionDecisionFields,
  InteractionPermissionPrompt,
  InteractionQuestion,
  InteractionQuestionOption,
  InteractionRequest,
  InteractionSandboxBoundaryAnswer,
  InteractionSandboxBoundaryRequest,
};

export const INTERACTION_SCHEMA_VERSION = 1 as const;
export const INTERACTION_PENDING_REVISION = 1 as const;
export const INTERACTION_RESOLVED_REVISION = 2 as const;
export const INTERACTION_MAX_PENDING_PER_SESSION = 16;

export type InteractionRevision =
  | typeof INTERACTION_PENDING_REVISION
  | typeof INTERACTION_RESOLVED_REVISION;

interface InteractionSnapshotBase {
  readonly schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  readonly interactionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly request: InteractionRequest;
}

export type InteractionPendingSnapshot = InteractionSnapshotBase & {
  readonly revision: typeof INTERACTION_PENDING_REVISION;
  readonly status: 'pending';
  readonly outcome: null;
};

export type InteractionAnsweredSnapshot = InteractionSnapshotBase & {
  readonly revision: typeof INTERACTION_RESOLVED_REVISION;
  readonly status: 'answered';
  readonly outcome: Exclude<InteractionCanonicalOutcome, { kind: 'closure' }>;
};

export type InteractionClosedSnapshot = InteractionSnapshotBase & {
  readonly revision: typeof INTERACTION_RESOLVED_REVISION;
  readonly status: 'closed';
  readonly outcome: Extract<InteractionCanonicalOutcome, { kind: 'closure' }>;
};

export type InteractionResolvedSnapshot = InteractionAnsweredSnapshot | InteractionClosedSnapshot;
export type InteractionSnapshot = InteractionPendingSnapshot | InteractionResolvedSnapshot;

export interface SessionInteractionProjection {
  readonly pending: readonly InteractionPendingSnapshot[];
}

export interface InteractionQueryInput {
  readonly sessionId: string;
  readonly interactionId: string;
}

export interface InteractionAnswerInput {
  readonly sessionId: string;
  readonly interactionId: string;
  readonly answer: InteractionAnswer;
}

export interface InteractionRespondByTextInput {
  readonly sessionId: string;
  readonly interactionId: string;
  readonly text: string;
}

export type InteractionRespondByTextResult =
  | { readonly kind: 'answered'; readonly snapshot: InteractionAnsweredSnapshot }
  | { readonly kind: 'unrecognized' }
  | { readonly kind: 'unavailable' };

const COMMON_ERRORS = ['host_not_ready', 'host_draining', 'operation_unavailable'] as const;

export const INTERACTION_OPERATION_SPECS = {
  'interaction.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    decodeInput: decodeInteractionQueryInput,
    decodeOutput: decodeInteractionSnapshot,
    errors: [...COMMON_ERRORS, 'not_found', 'internal_failure'] as const,
  }),
  'interaction.answer': defineOperation({
    mode: 'command',
    availability: 'ready',
    decodeInput: decodeInteractionAnswerInput,
    decodeOutput: decodeInteractionAnsweredSnapshot,
    errors: [
      ...COMMON_ERRORS,
      'not_found',
      'operation_conflict',
      'already_resolved',
      'internal_failure',
    ] as const,
  }),
  'interaction.respondByText': defineOperation({
    mode: 'command',
    availability: 'ready',
    decodeInput: decodeInteractionRespondByTextInput,
    decodeOutput: decodeInteractionRespondByTextResult,
    assertOutputForInput(input, output) {
      if (
        output.kind === 'answered' &&
        (output.snapshot.sessionId !== input.sessionId ||
          output.snapshot.interactionId !== input.interactionId ||
          output.snapshot.request.kind !== 'client_capability' ||
          output.snapshot.request.target.capability !== 'computer_use' ||
          (output.snapshot.request.target.scope.kind !== 'capability' &&
            output.snapshot.request.target.scope.kind !== 'computer_use_foreground') ||
          output.snapshot.outcome.kind !== 'client_capability_decision' ||
          output.snapshot.outcome.responseText !== input.text)
      ) {
        throw invalidProtocolFrame('Text authorization output does not match its request');
      }
    },
    errors: [...COMMON_ERRORS, 'internal_failure'] as const,
  }),
} as const;

export function decodeInteractionRequest(value: unknown): InteractionRequest {
  return decodeCoreValue(value, 'Interaction request', decodeCoreInteractionRequest);
}

export function decodeInteractionAnswer(value: unknown): InteractionAnswer {
  return decodeCoreValue(value, 'Interaction answer', decodeCoreInteractionAnswer);
}

export function decodeInteractionCanonicalOutcome(value: unknown): InteractionCanonicalOutcome {
  return decodeCoreValue(
    value,
    'Interaction canonical outcome',
    decodeCoreInteractionCanonicalOutcome,
  );
}

export function decodeInteractionSnapshot(value: unknown): InteractionSnapshot {
  const record = requireRecord(value, 'Interaction snapshot');
  assertExactKeys(record, 'Interaction snapshot', [
    'schemaVersion',
    'interactionId',
    'sessionId',
    'turnId',
    'runId',
    'revision',
    'request',
    'status',
    'outcome',
  ]);
  if (record.schemaVersion !== INTERACTION_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported Interaction snapshot schema');
  }

  const request = decodeInteractionRequest(record.request);
  const revision = requireInteractionRevision(record.revision);
  const base: InteractionSnapshotBase = {
    schemaVersion: INTERACTION_SCHEMA_VERSION,
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
    request,
  };

  if (record.status === 'pending') {
    if (revision !== INTERACTION_PENDING_REVISION || record.outcome !== null) {
      throw invalidProtocolFrame('Invalid pending Interaction snapshot');
    }
    return { ...base, revision, status: 'pending', outcome: null };
  }
  if (record.status !== 'answered' && record.status !== 'closed') {
    throw invalidProtocolFrame('Invalid Interaction status');
  }
  if (revision !== INTERACTION_RESOLVED_REVISION) {
    throw invalidProtocolFrame('Invalid resolved Interaction revision');
  }

  const outcome = decodeInteractionCanonicalOutcome(record.outcome);
  if (!isInteractionCanonicalOutcomeValidForRequest(request, outcome)) {
    throw invalidProtocolFrame('Interaction outcome does not match its request');
  }
  if (record.status === 'answered') {
    if (outcome.kind === 'closure') {
      throw invalidProtocolFrame('Answered Interaction has a closure outcome');
    }
    return { ...base, revision, status: 'answered', outcome };
  }
  if (outcome.kind !== 'closure') {
    throw invalidProtocolFrame('Closed Interaction has an answer outcome');
  }
  return { ...base, revision, status: 'closed', outcome };
}

export function decodeInteractionAnsweredSnapshot(value: unknown): InteractionAnsweredSnapshot {
  const snapshot = decodeInteractionSnapshot(value);
  if (snapshot.status !== 'answered') {
    throw invalidProtocolFrame('Interaction answer output is not answered');
  }
  return snapshot;
}

export function decodeSessionInteractionProjection(
  value: unknown,
  sessionId: string,
): SessionInteractionProjection {
  const record = requireRecord(value, 'Session Interaction projection');
  assertExactKeys(record, 'Session Interaction projection', ['pending']);
  if (
    !Array.isArray(record.pending) ||
    record.pending.length > INTERACTION_MAX_PENDING_PER_SESSION
  ) {
    throw invalidProtocolFrame('Invalid pending Interactions');
  }

  const identities = new Set<string>();
  const pending = record.pending.map((candidate) => {
    const snapshot = decodeInteractionSnapshot(candidate);
    if (snapshot.status !== 'pending') {
      throw invalidProtocolFrame('Pending Interaction projection contains a resolved Interaction');
    }
    if (snapshot.sessionId !== sessionId) {
      throw invalidProtocolFrame('Interaction projection belongs to a different Session');
    }
    if (identities.has(snapshot.interactionId)) {
      throw invalidProtocolFrame('Session Interaction projection repeats an Interaction identity');
    }
    identities.add(snapshot.interactionId);
    return snapshot;
  });
  return { pending };
}

function decodeInteractionQueryInput(value: unknown): InteractionQueryInput {
  const record = requireRecord(value, 'interaction.query input');
  assertExactKeys(record, 'interaction.query input', ['sessionId', 'interactionId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
  };
}

function decodeInteractionAnswerInput(value: unknown): InteractionAnswerInput {
  const record = requireRecord(value, 'interaction.answer input');
  assertExactKeys(record, 'interaction.answer input', ['sessionId', 'interactionId', 'answer']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
    answer: decodeInteractionAnswer(record.answer),
  };
}

function decodeInteractionRespondByTextInput(value: unknown): InteractionRespondByTextInput {
  const record = requireRecord(value, 'interaction.respondByText input');
  assertExactKeys(record, 'interaction.respondByText input', [
    'sessionId',
    'interactionId',
    'text',
  ]);
  const text = requireString(
    record.text,
    'authorization text',
    INTERACTION_AUTHORIZATION_TEXT_MAX_BYTES,
  );
  if (new TextEncoder().encode(text).byteLength > INTERACTION_AUTHORIZATION_TEXT_MAX_BYTES) {
    throw invalidProtocolFrame('Authorization text exceeds its byte limit');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    interactionId: requireEntityId(record.interactionId, 'interactionId'),
    text,
  };
}

function decodeInteractionRespondByTextResult(value: unknown): InteractionRespondByTextResult {
  const record = requireRecord(value, 'interaction.respondByText output');
  if (record.kind === 'answered') {
    assertExactKeys(record, 'interaction.respondByText output', ['kind', 'snapshot']);
    return { kind: 'answered', snapshot: decodeInteractionAnsweredSnapshot(record.snapshot) };
  }
  assertExactKeys(record, 'interaction.respondByText output', ['kind']);
  if (record.kind !== 'unrecognized' && record.kind !== 'unavailable') {
    throw invalidProtocolFrame('Invalid text authorization result');
  }
  return { kind: record.kind };
}

function decodeCoreValue<T>(value: unknown, label: string, decode: (candidate: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
}

function requireInteractionRevision(value: unknown): InteractionRevision {
  if (value === INTERACTION_PENDING_REVISION || value === INTERACTION_RESOLVED_REVISION) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Interaction revision');
}
