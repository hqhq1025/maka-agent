import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CU_E2E_CRITICAL_TRIPLES,
  CU_E2E_PAIRWISE_DIMENSIONS,
  CU_E2E_PAIRWISE_OBLIGATIONS,
  CU_E2E_PR_SEEDS,
  CU_E2E_REPLAY_REPORT_VERSION,
  CU_E2E_SEQUENCE_LENGTH,
  createReferenceOwnershipModel,
  createReplayReportV3,
  createXorshift32,
  criticalTripleCoverage,
  forbiddenSequenceViolations,
  generateCuE2ePrSequences,
  generateCuE2eSequence,
  pairwiseCoverage,
  shrinkFailurePrefix,
  xorshift32,
} from './cu-e2e-sequences.mjs';

test('xorshift32 has a stable uint32 stream and rejects a zero generator seed', () => {
  assert.equal(xorshift32(0xC0A00001), 0xD4A84A71);
  const random = createXorshift32(0xC0A00001);
  assert.deepEqual(
    [random.nextUint32(), random.nextUint32(), random.nextUint32()],
    [0xD4A84A71, 0x612694C2, 0xC46F2EBD],
  );
  assert.throws(() => createXorshift32(0), /non-zero seed/);
});

test('the four PR seeds deterministically produce 32 symbolic contextual steps', () => {
  assert.deepEqual(CU_E2E_PR_SEEDS, [
    0xC0A00001,
    0xC0A00002,
    0xC0A00003,
    0xC0A00004,
  ]);

  const first = generateCuE2ePrSequences();
  const second = generateCuE2ePrSequences();
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);

  for (const [index, sequence] of first.entries()) {
    assert.equal(sequence.seed, CU_E2E_PR_SEEDS[index]);
    assert.equal(sequence.length, CU_E2E_SEQUENCE_LENGTH);
    assert.equal(sequence.steps.length, CU_E2E_SEQUENCE_LENGTH);
    assert.equal(sequence.generator, 'xorshift32');
    for (const step of sequence.steps) {
      assert.equal(typeof step.symbol, 'string');
      assert.equal(typeof step.target, 'string');
      assert.equal(step.action.target, step.target);
      assert.equal(typeof step.context.sessionId, 'string');
      assert.equal(typeof step.context.turnId, 'string');
      assert.equal(typeof step.context.toolCallId, 'string');
      assert.deepEqual(Object.keys(step.factors), CU_E2E_PAIRWISE_DIMENSIONS);
    }
  }

  assert.notDeepEqual(first[0].steps.slice(24), first[1].steps.slice(24));
  assert.deepEqual(
    generateCuE2eSequence({ seed: CU_E2E_PR_SEEDS[0] }),
    generateCuE2eSequence({ seed: CU_E2E_PR_SEEDS[0] }),
  );
});

test('the PR seed suite contains every fixed critical triple', () => {
  assert.equal(CU_E2E_CRITICAL_TRIPLES.length, 8);
  const coverage = criticalTripleCoverage(generateCuE2ePrSequences());
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.missing, []);
});

test('the PR seed suite covers every constrained pairwise obligation', () => {
  assert.ok(CU_E2E_PAIRWISE_OBLIGATIONS.length > 0);
  for (const obligation of CU_E2E_PAIRWISE_OBLIGATIONS) {
    assert.equal(obligation.dimensions.length, 2);
    assert.ok(
      CU_E2E_PAIRWISE_DIMENSIONS.indexOf(obligation.dimensions[0])
        < CU_E2E_PAIRWISE_DIMENSIONS.indexOf(obligation.dimensions[1]),
    );
  }

  const coverage = pairwiseCoverage(generateCuE2ePrSequences());
  assert.equal(coverage.complete, true, JSON.stringify(coverage.missing, null, 2));
  assert.equal(coverage.covered, coverage.total);
});

test('reference ownership follows click, context, revocation, and preserve rules', () => {
  const model = createReferenceOwnershipModel();
  const clickA = model.apply({
    symbol: 'click-editable-a-semantic',
    context: 'primary',
  });
  assert.equal(clickA.expected.ownerAfter, 'window-a.textarea');

  const scroll = model.apply({
    symbol: 'scroll-window-a',
    context: 'primary',
  });
  assert.equal(scroll.expected.ownerBefore, 'window-a.textarea');
  assert.equal(scroll.expected.ownerAfter, 'window-a.textarea');

  const typed = model.apply({
    symbol: 'type-text',
    context: 'primary',
  });
  assert.equal(typed.expected.ok, true);
  assert.equal(typed.expected.typedTarget, 'window-a.textarea');

  const otherSession = model.apply({
    symbol: 'type-text',
    context: 'other-session',
  });
  assert.equal(otherSession.expected.ok, false);
  assert.equal(otherSession.expected.ownerBefore, 'none');

  const failedClick = model.apply({
    symbol: 'click-editable-b-semantic-rejected',
    context: 'primary',
  });
  assert.equal(failedClick.expected.ok, false);
  assert.equal(failedClick.expected.ownerAfter, 'none');
  assert.equal(failedClick.expected.fallbackAllowed, false);

  const afterFailure = model.apply({
    symbol: 'type-text',
    context: 'primary',
  });
  assert.equal(afterFailure.expected.ok, false);

  model.apply({
    symbol: 'click-editable-a-semantic',
    context: 'primary',
  });
  const staleTurn = model.apply({
    symbol: 'type-text',
    context: 'next-turn',
  });
  assert.equal(staleTurn.expected.ownerBefore, 'stale-turn');
  assert.equal(staleTurn.expected.ok, false);
  const invalidatedOriginalTurn = model.apply({
    symbol: 'type-text',
    context: 'primary',
  });
  assert.equal(invalidatedOriginalTurn.expected.ownerBefore, 'none');

  model.apply({
    symbol: 'click-editable-b-semantic',
    context: 'primary',
  });
  model.clearSession('session-a');
  assert.equal(
    model.apply({ symbol: 'type-text', context: 'primary' }).expected.ok,
    false,
  );
});

test('generated sequences contain no unsafe or model-inconsistent transition', () => {
  const sequences = generateCuE2ePrSequences();
  for (const sequence of sequences) {
    assert.deepEqual(forbiddenSequenceViolations(sequence), []);
  }

  const tampered = structuredClone(sequences[0]);
  const rejected = tampered.steps.find(
    (step) => step.symbol === 'click-editable-b-semantic-rejected',
  );
  rejected.expected.ok = true;
  rejected.expected.fallbackAllowed = true;
  const violations = forbiddenSequenceViolations(tampered);
  assert.ok(violations.some((entry) => entry.code === 'reference-model-mismatch'));
  assert.ok(violations.some((entry) => entry.code === 'semantic-rejection-fell-through'));
});

test('replay report helper emits schema v3 with generator and coverage evidence', () => {
  const sequence = generateCuE2ePrSequences()[0];
  const report = createReplayReportV3({
    runId: 'pr-replay-1',
    sequence,
    startedAt: '2026-07-12T00:00:00.000Z',
    results: sequence.steps.map((step) => ({
      stepId: step.id,
      pass: true,
    })),
    metadata: { lane: 'pr' },
  });

  assert.equal(report.version, CU_E2E_REPLAY_REPORT_VERSION);
  assert.equal(report.version, 3);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.schema, 'maka.computer-use.e2e-replay');
  assert.equal(report.generator.seedHex, '0xC0A00001');
  assert.equal(report.sequence.length, 32);
  assert.equal(report.replay.status, 'passed');
  assert.deepEqual(report.coverage.criticalTriples.covered, [
    'owner-follows-second-editable-click',
    'non-editable-click-refuses-type',
  ]);
  assert.equal(report.coverage.criticalTriples.complete, false);
  assert.deepEqual(report.metadata, { lane: 'pr' });

  const failed = createReplayReportV3({
    sequence,
    results: [{ stepId: sequence.steps[0].id, pass: false }],
  });
  assert.equal(failed.replay.status, 'failed');
});

test('failure-prefix shrink finds the shortest reproducing prefix without mutation', async () => {
  const sequence = generateCuE2ePrSequences()[0];
  const before = structuredClone(sequence.steps);
  const failureStepId = sequence.steps[11].id;
  const shrunk = await shrinkFailurePrefix(
    sequence,
    async (prefix) => prefix.some((step) => step.id === failureStepId),
  );

  assert.equal(shrunk.originalLength, 32);
  assert.equal(shrunk.minimalLength, 12);
  assert.equal(shrunk.prefix.at(-1).id, failureStepId);
  assert.ok(shrunk.attempts.length <= 7);
  assert.deepEqual(sequence.steps, before);

  await assert.rejects(
    shrinkFailurePrefix(sequence.steps, () => false),
    /does not reproduce the failure/,
  );
});
