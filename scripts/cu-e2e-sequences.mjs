export const CU_E2E_PR_SEEDS = Object.freeze([
  0xC0A00001,
  0xC0A00002,
  0xC0A00003,
  0xC0A00004,
]);
export const CU_E2E_SEQUENCE_LENGTH = 32;
export const CU_E2E_REPLAY_REPORT_VERSION = 3;
export const CU_E2E_PAIRWISE_DIMENSIONS = Object.freeze([
  'owner',
  'context',
  'transition',
  'semantic',
  'target',
]);

export const CU_E2E_CONTEXTS = deepFreeze({
  primary: {
    key: 'primary',
    sessionId: 'session-a',
    turnId: 'turn-1',
  },
  nextTurn: {
    key: 'next-turn',
    sessionId: 'session-a',
    turnId: 'turn-2',
  },
  otherSession: {
    key: 'other-session',
    sessionId: 'session-b',
    turnId: 'turn-1',
  },
});

export const CU_E2E_SYMBOL_TARGETS = deepFreeze({
  editableA: {
    symbol: 'window-a.textarea',
    window: 'window-a',
    kind: 'editable',
  },
  editableB: {
    symbol: 'window-b.textarea',
    window: 'window-b',
    kind: 'editable',
  },
  buttonA: {
    symbol: 'window-a.button',
    window: 'window-a',
    kind: 'non-editable',
  },
  scrollA: {
    symbol: 'window-a.scrollbox',
    window: 'window-a',
    kind: 'scrollable',
  },
  rangeA: {
    symbol: 'window-a.range',
    window: 'window-a',
    kind: 'draggable',
  },
  emptyDesktop: {
    symbol: 'desktop.empty',
    window: null,
    kind: 'forbidden-desktop',
  },
  crossWindow: {
    symbol: 'window-a.range->window-b.range',
    window: null,
    kind: 'forbidden-cross-window',
  },
});

export const CU_E2E_SYMBOLS = deepFreeze({
  'click-editable-a-semantic': {
    actionType: 'left_click',
    target: CU_E2E_SYMBOL_TARGETS.editableA.symbol,
    semantic: 'confirmed',
    outcome: 'success',
    ownership: 'establish',
    editable: true,
  },
  'click-editable-b-semantic': {
    actionType: 'left_click',
    target: CU_E2E_SYMBOL_TARGETS.editableB.symbol,
    semantic: 'confirmed',
    outcome: 'success',
    ownership: 'establish',
    editable: true,
  },
  'click-button-a-semantic': {
    actionType: 'left_click',
    target: CU_E2E_SYMBOL_TARGETS.buttonA.symbol,
    semantic: 'confirmed',
    outcome: 'success',
    ownership: 'establish',
    editable: false,
  },
  'click-editable-a-fallback': {
    actionType: 'left_click',
    target: CU_E2E_SYMBOL_TARGETS.editableA.symbol,
    semantic: 'unsupported-fallback-confirmed',
    outcome: 'success',
    ownership: 'establish',
    editable: true,
  },
  'click-editable-b-semantic-rejected': {
    actionType: 'left_click',
    target: CU_E2E_SYMBOL_TARGETS.editableB.symbol,
    semantic: 'supported-rejected',
    outcome: 'refused',
    ownership: 'revoke',
    editable: true,
  },
  'click-empty-desktop-refused': {
    actionType: 'left_click',
    target: CU_E2E_SYMBOL_TARGETS.emptyDesktop.symbol,
    semantic: 'not-applicable',
    outcome: 'refused',
    ownership: 'revoke',
  },
  'type-text': {
    actionType: 'type',
    target: '$owner',
    semantic: 'not-applicable',
    outcome: 'state-dependent',
    ownership: 'consume',
  },
  'scroll-window-a': {
    actionType: 'scroll',
    target: CU_E2E_SYMBOL_TARGETS.scrollA.symbol,
    semantic: 'not-applicable',
    outcome: 'success',
    ownership: 'preserve',
  },
  'scroll-empty-desktop-refused': {
    actionType: 'scroll',
    target: CU_E2E_SYMBOL_TARGETS.emptyDesktop.symbol,
    semantic: 'not-applicable',
    outcome: 'refused',
    ownership: 'preserve',
  },
  'drag-range-a': {
    actionType: 'left_click_drag',
    target: CU_E2E_SYMBOL_TARGETS.rangeA.symbol,
    semantic: 'confirmed',
    outcome: 'success',
    ownership: 'preserve',
  },
  'drag-cross-window-refused': {
    actionType: 'left_click_drag',
    target: CU_E2E_SYMBOL_TARGETS.crossWindow.symbol,
    semantic: 'not-applicable',
    outcome: 'refused',
    ownership: 'preserve',
  },
  'key-chord-refused': {
    actionType: 'key',
    target: '$owner',
    semantic: 'not-applicable',
    outcome: 'refused',
    ownership: 'preserve',
  },
});

export const CU_E2E_CRITICAL_TRIPLES = deepFreeze([
  {
    id: 'owner-follows-second-editable-click',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('click-editable-b-semantic', 'primary'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'non-editable-click-refuses-type',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('click-button-a-semantic', 'primary'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'failed-click-revokes-owner',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('click-empty-desktop-refused', 'primary'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'semantic-rejection-never-falls-through',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('click-editable-b-semantic-rejected', 'primary'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'scroll-preserves-owner',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('scroll-window-a', 'primary'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'drag-preserves-owner',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('drag-range-a', 'primary'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'new-turn-invalidates-owner',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('type-text', 'next-turn'),
      spec('type-text', 'primary'),
    ],
  },
  {
    id: 'other-session-cannot-consume-owner',
    steps: [
      spec('click-editable-a-semantic', 'primary'),
      spec('type-text', 'other-session'),
      spec('type-text', 'primary'),
    ],
  },
]);

const GENERATOR_CANDIDATES = Object.freeze(
  Object.keys(CU_E2E_SYMBOLS).flatMap((symbol) =>
    Object.values(CU_E2E_CONTEXTS).map((context) => spec(symbol, context.key))),
);

export function xorshift32(value) {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

export function createXorshift32(seed) {
  let state = seed >>> 0;
  if (state === 0) {
    throw new RangeError('xorshift32 requires a non-zero seed');
  }
  return Object.freeze({
    nextUint32() {
      state = xorshift32(state);
      return state;
    },
  });
}

export function createReferenceOwnershipModel(initialState) {
  let state = normalizeState(initialState);
  return {
    apply(stepInput) {
      const result = applyReferenceOwnershipStep(state, stepInput);
      state = result.state;
      return result.observation;
    },
    snapshot() {
      return cloneState(state);
    },
    clearSession(sessionId) {
      delete state.owners[sessionId];
    },
  };
}

export function applyReferenceOwnershipStep(stateInput, stepInput) {
  const state = normalizeState(stateInput);
  const symbol = resolveSymbol(stepInput.symbol);
  const context = resolveContext(stepInput.context);
  const ownerBefore = inspectOwner(state, context);

  if (ownerBefore.kind === 'stale-turn') {
    delete state.owners[context.sessionId];
  }
  const exactOwner = state.owners[context.sessionId]?.turnId === context.turnId
    ? state.owners[context.sessionId]
    : undefined;

  let ok = symbol.outcome === 'success';
  let transition = symbol.ownership;
  let target = symbol.target;
  let route = routeForSymbol(symbol);
  let error;

  if (symbol.actionType === 'left_click') {
    delete state.owners[context.sessionId];
    if (symbol.outcome === 'success') {
      state.owners[context.sessionId] = {
        turnId: context.turnId,
        target: symbol.target,
        editable: symbol.editable === true,
      };
    } else {
      ok = false;
      error = 'unsupported_action';
    }
  } else if (symbol.actionType === 'type') {
    target = exactOwner?.target ?? 'no-owner';
    ok = exactOwner?.editable === true;
    transition = ok ? 'consume' : 'refuse';
    route = ok ? 'owned-text' : 'fail-closed';
    if (!ok) error = 'unsupported_action';
  } else if (symbol.actionType === 'key') {
    target = exactOwner?.target ?? 'no-owner';
    ok = false;
    route = 'fail-closed';
    error = 'unsupported_action';
  } else if (symbol.outcome === 'refused') {
    ok = false;
    route = 'fail-closed';
    error = 'unsupported_action';
  }

  const ownerAfter = inspectOwner(state, context);
  const factors = {
    owner: ownerFactor(ownerBefore),
    context: context.key,
    transition,
    semantic: symbol.semantic,
    target,
  };
  const expected = {
    ok,
    transition,
    route,
    ownerBefore: ownerFactor(ownerBefore),
    ownerAfter: ownerFactor(ownerAfter),
    fallbackAllowed: symbol.semantic === 'unsupported-fallback-confirmed',
    ...(ok ? {} : { error }),
    ...(symbol.actionType === 'type' && ok ? { typedTarget: target } : {}),
  };

  return {
    state,
    observation: {
      symbol: stepInput.symbol,
      target,
      context,
      factors,
      expected,
    },
  };
}

export function buildConstrainedPairwiseObligations() {
  const observations = enumerateReachableObservations();
  const obligations = new Map();
  for (const observation of observations) {
    for (const obligation of obligationsForFactors(observation.factors)) {
      obligations.set(obligation.key, obligation);
    }
  }
  return [...obligations.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export const CU_E2E_PAIRWISE_OBLIGATIONS = deepFreeze(
  buildConstrainedPairwiseObligations(),
);

export function generateCuE2eSequence({
  seed,
  length = CU_E2E_SEQUENCE_LENGTH,
  precovered = [],
} = {}) {
  return generateSequenceWithCriticalTriples({
    seed,
    length,
    precovered,
    criticalTriples: CU_E2E_CRITICAL_TRIPLES,
  });
}

function generateSequenceWithCriticalTriples({
  seed,
  length,
  precovered,
  criticalTriples,
}) {
  if (!Number.isInteger(seed)) {
    throw new TypeError('seed must be an integer');
  }
  if (length < criticalPrefixLength(criticalTriples)) {
    throw new RangeError(
      `length must be at least ${criticalPrefixLength(criticalTriples)} `
      + 'to include the selected critical triples',
    );
  }

  const normalizedSeed = seed >>> 0;
  const rng = createXorshift32(normalizedSeed);
  const model = createReferenceOwnershipModel();
  const steps = [];
  const covered = new Set(precovered);

  for (const triple of criticalTriples) {
    for (const stepSpec of triple.steps) {
      const step = appendGeneratedStep({
        steps,
        model,
        stepSpec,
        seed: normalizedSeed,
        source: `critical:${triple.id}`,
      });
      addCoveredPairs(covered, step);
    }
  }

  while (steps.length < length) {
    const choice = chooseCandidate({
      state: model.snapshot(),
      covered,
      rng,
    });
    const step = appendGeneratedStep({
      steps,
      model,
      stepSpec: choice,
      seed: normalizedSeed,
      source: 'pairwise',
    });
    addCoveredPairs(covered, step);
  }

  return deepFreeze({
    id: `cu-e2e-${seedHex(normalizedSeed)}`,
    seed: normalizedSeed,
    seedHex: seedHex(normalizedSeed),
    generator: 'xorshift32',
    length: steps.length,
    steps,
  });
}

export function generateCuE2ePrSequences() {
  const covered = new Set();
  const sequences = [];
  for (const [index, seed] of CU_E2E_PR_SEEDS.entries()) {
    const sequence = generateSequenceWithCriticalTriples({
      seed,
      length: CU_E2E_SEQUENCE_LENGTH,
      precovered: covered,
      criticalTriples: CU_E2E_CRITICAL_TRIPLES.slice(index * 2, index * 2 + 2),
    });
    sequences.push(sequence);
    for (const step of sequence.steps) addCoveredPairs(covered, step);
  }
  return deepFreeze(sequences);
}

export function pairwiseCoverage(sequenceInput) {
  const steps = collectSteps(sequenceInput);
  const coveredKeys = new Set();
  for (const step of steps) {
    for (const obligation of obligationsForFactors(step.factors)) {
      coveredKeys.add(obligation.key);
    }
  }
  const missing = CU_E2E_PAIRWISE_OBLIGATIONS
    .filter((obligation) => !coveredKeys.has(obligation.key));
  return {
    total: CU_E2E_PAIRWISE_OBLIGATIONS.length,
    covered: CU_E2E_PAIRWISE_OBLIGATIONS.length - missing.length,
    missing,
    complete: missing.length === 0,
  };
}

export function criticalTripleCoverage(sequenceInput) {
  const steps = collectSteps(sequenceInput);
  const covered = [];
  const missing = [];
  for (const triple of CU_E2E_CRITICAL_TRIPLES) {
    const found = findSubsequence(steps, triple.steps);
    (found ? covered : missing).push(triple.id);
  }
  return {
    covered,
    missing,
    complete: missing.length === 0,
  };
}

export function forbiddenSequenceViolations(sequenceInput) {
  const steps = collectSteps(sequenceInput);
  const model = createReferenceOwnershipModel();
  const violations = [];

  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') {
      violations.push({ index, code: 'invalid-step' });
      return;
    }
    if (typeof step.target !== 'string' || !step.context) {
      violations.push({ index, code: 'missing-symbol-target-or-context' });
      return;
    }

    let expectedObservation;
    try {
      expectedObservation = model.apply(step);
    } catch (error) {
      violations.push({
        index,
        code: 'unknown-symbol-or-context',
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const symbol = CU_E2E_SYMBOLS[step.symbol];
    if (!sameJson(step.expected, expectedObservation.expected)) {
      violations.push({ index, code: 'reference-model-mismatch' });
    }
    if (!sameJson(step.factors, expectedObservation.factors)) {
      violations.push({ index, code: 'pairwise-factor-mismatch' });
    }
    if (step.target !== expectedObservation.target) {
      violations.push({ index, code: 'symbol-target-mismatch' });
    }
    if (
      symbol.semantic === 'supported-rejected'
      && (step.expected?.ok || step.expected?.fallbackAllowed)
    ) {
      violations.push({ index, code: 'semantic-rejection-fell-through' });
    }
    if (
      (step.target === CU_E2E_SYMBOL_TARGETS.emptyDesktop.symbol
        || step.target === CU_E2E_SYMBOL_TARGETS.crossWindow.symbol)
      && step.expected?.ok
    ) {
      violations.push({ index, code: 'forbidden-target-succeeded' });
    }
    if (symbol.actionType === 'key' && step.expected?.ok) {
      violations.push({ index, code: 'background-key-succeeded' });
    }
  });

  return violations;
}

export function createReplayReportV3({
  runId,
  sequence,
  results = [],
  failure = null,
  shrink = null,
  startedAt,
  metadata = {},
} = {}) {
  if (!sequence?.steps || !Number.isInteger(sequence.seed)) {
    throw new TypeError('sequence with integer seed and steps is required');
  }
  const coverage = pairwiseCoverage(sequence);
  const critical = criticalTripleCoverage(sequence);
  const status = failure || results.some((result) => result?.pass === false)
    ? 'failed'
    : results.length === sequence.steps.length
      ? 'passed'
      : 'pending';

  return {
    version: CU_E2E_REPLAY_REPORT_VERSION,
    schemaVersion: CU_E2E_REPLAY_REPORT_VERSION,
    schema: 'maka.computer-use.e2e-replay',
    runId: runId ?? `${sequence.id}-replay`,
    ...(startedAt ? { startedAt } : {}),
    generator: {
      algorithm: sequence.generator,
      seed: sequence.seed,
      seedHex: sequence.seedHex,
      requestedSteps: sequence.length,
    },
    sequence: {
      id: sequence.id,
      length: sequence.steps.length,
      steps: sequence.steps,
    },
    coverage: {
      pairwise: {
        total: coverage.total,
        covered: coverage.covered,
        missing: coverage.missing.map((entry) => entry.key),
      },
      criticalTriples: critical,
    },
    replay: {
      status,
      results,
    },
    failure,
    shrink,
    metadata,
  };
}

export async function shrinkFailurePrefix(sequenceInput, fails) {
  if (typeof fails !== 'function') {
    throw new TypeError('fails must be a function');
  }
  const steps = collectSteps(sequenceInput);
  if (steps.length === 0) {
    throw new RangeError('cannot shrink an empty sequence');
  }

  const attempts = [];
  const testPrefix = async (length) => {
    const failed = Boolean(await fails(steps.slice(0, length)));
    attempts.push({ length, failed });
    return failed;
  };

  if (!(await testPrefix(steps.length))) {
    throw new Error('the full sequence does not reproduce the failure');
  }

  let low = 1;
  let high = steps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await testPrefix(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return {
    originalLength: steps.length,
    minimalLength: low,
    removedSteps: steps.length - low,
    prefix: steps.slice(0, low),
    attempts,
  };
}

function appendGeneratedStep({
  steps,
  model,
  stepSpec,
  seed,
  source,
}) {
  const index = steps.length;
  const context = resolveContext(stepSpec.context);
  const observation = model.apply({
    symbol: stepSpec.symbol,
    context,
  });
  const symbol = resolveSymbol(stepSpec.symbol);
  const step = {
    index,
    id: `${seedHex(seed)}:${String(index).padStart(2, '0')}`,
    source,
    symbol: stepSpec.symbol,
    action: {
      type: symbol.actionType,
      target: observation.target,
      ...(symbol.actionType === 'type'
        ? { text: `CU-${seedHex(seed)}-${String(index).padStart(2, '0')}` }
        : {}),
      ...(symbol.actionType === 'key' ? { text: 'cmd+a' } : {}),
    },
    target: observation.target,
    context: {
      ...context,
      toolCallId: `cu-${seedHex(seed)}-${String(index).padStart(2, '0')}`,
    },
    semantic: symbol.semantic,
    factors: observation.factors,
    expected: observation.expected,
  };
  steps.push(step);
  return step;
}

function chooseCandidate({
  state,
  covered,
  rng,
}) {
  let bestScore = -1;
  let best = [];

  for (const candidate of GENERATOR_CANDIDATES) {
    const result = applyReferenceOwnershipStep(state, candidate);
    const immediate = uncoveredCount(result.observation.factors, covered);
    let lookahead = 0;
    for (const next of GENERATOR_CANDIDATES) {
      const nextResult = applyReferenceOwnershipStep(result.state, next);
      lookahead = Math.max(
        lookahead,
        uncoveredCount(nextResult.observation.factors, covered),
      );
    }
    const score = immediate * 100 + lookahead;
    if (score > bestScore) {
      bestScore = score;
      best = [candidate];
    } else if (score === bestScore) {
      best.push(candidate);
    }
  }

  return best[rng.nextUint32() % best.length];
}

function enumerateReachableObservations() {
  const initial = normalizeState();
  const queue = [initial];
  const seen = new Set([stateKey(initial)]);
  const observations = [];

  while (queue.length > 0) {
    const state = queue.shift();
    for (const candidate of GENERATOR_CANDIDATES) {
      const result = applyReferenceOwnershipStep(state, candidate);
      observations.push(result.observation);
      const key = stateKey(result.state);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(result.state);
      }
    }
  }

  return observations;
}

function obligationsForFactors(factors) {
  const obligations = [];
  for (let left = 0; left < CU_E2E_PAIRWISE_DIMENSIONS.length; left += 1) {
    for (let right = left + 1; right < CU_E2E_PAIRWISE_DIMENSIONS.length; right += 1) {
      const leftDimension = CU_E2E_PAIRWISE_DIMENSIONS[left];
      const rightDimension = CU_E2E_PAIRWISE_DIMENSIONS[right];
      const values = {
        [leftDimension]: factors[leftDimension],
        [rightDimension]: factors[rightDimension],
      };
      obligations.push({
        dimensions: [leftDimension, rightDimension],
        values,
        key: JSON.stringify([
          leftDimension,
          factors[leftDimension],
          rightDimension,
          factors[rightDimension],
        ]),
      });
    }
  }
  return obligations;
}

function uncoveredCount(factors, covered) {
  return obligationsForFactors(factors)
    .filter((obligation) => !covered.has(obligation.key))
    .length;
}

function addCoveredPairs(covered, step) {
  for (const obligation of obligationsForFactors(step.factors)) {
    covered.add(obligation.key);
  }
}

function inspectOwner(state, context) {
  const owner = state.owners[context.sessionId];
  if (!owner) return { kind: 'none' };
  if (owner.turnId !== context.turnId) {
    return {
      kind: 'stale-turn',
      target: owner.target,
      editable: owner.editable,
    };
  }
  return {
    kind: 'owned',
    target: owner.target,
    editable: owner.editable,
  };
}

function ownerFactor(owner) {
  if (owner.kind === 'owned') return owner.target;
  return owner.kind;
}

function routeForSymbol(symbol) {
  if (symbol.semantic === 'confirmed') return 'semantic';
  if (symbol.semantic === 'supported-rejected') return 'semantic-refused';
  if (symbol.semantic === 'unsupported-fallback-confirmed') {
    return 'window-local-fallback';
  }
  if (symbol.outcome === 'refused') return 'fail-closed';
  return 'window-local';
}

function resolveSymbol(symbol) {
  const resolved = CU_E2E_SYMBOLS[symbol];
  if (!resolved) throw new RangeError(`unknown Computer Use E2E symbol: ${symbol}`);
  return resolved;
}

function resolveContext(context) {
  if (typeof context === 'string') {
    const resolved = Object.values(CU_E2E_CONTEXTS)
      .find((candidate) => candidate.key === context);
    if (!resolved) throw new RangeError(`unknown Computer Use E2E context: ${context}`);
    return resolved;
  }
  if (
    context
    && typeof context.key === 'string'
    && typeof context.sessionId === 'string'
    && typeof context.turnId === 'string'
  ) {
    return {
      key: context.key,
      sessionId: context.sessionId,
      turnId: context.turnId,
    };
  }
  throw new TypeError('Computer Use E2E context must include key, sessionId, and turnId');
}

function normalizeState(state) {
  if (!state) return { owners: {} };
  return cloneState(state);
}

function cloneState(state) {
  return {
    owners: Object.fromEntries(
      Object.entries(state.owners ?? {}).map(([sessionId, owner]) => [
        sessionId,
        { ...owner },
      ]),
    ),
  };
}

function stateKey(state) {
  return JSON.stringify(
    Object.entries(state.owners)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function criticalPrefixLength(criticalTriples) {
  return criticalTriples
    .reduce((total, triple) => total + triple.steps.length, 0);
}

function spec(symbol, context) {
  return { symbol, context };
}

function seedHex(seed) {
  return `0x${(seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function collectSteps(sequenceInput) {
  if (Array.isArray(sequenceInput)) {
    if (sequenceInput.every((entry) => Array.isArray(entry?.steps))) {
      return sequenceInput.flatMap((entry) => entry.steps);
    }
    return sequenceInput;
  }
  if (Array.isArray(sequenceInput?.steps)) return sequenceInput.steps;
  throw new TypeError('expected a generated sequence, a sequence list, or a step list');
}

function findSubsequence(steps, expectedSpecs) {
  for (let start = 0; start <= steps.length - expectedSpecs.length; start += 1) {
    const matches = expectedSpecs.every((expected, offset) => {
      const actual = steps[start + offset];
      return actual.symbol === expected.symbol
        && actual.context.key === resolveContext(expected.context).key;
    });
    if (matches) return true;
  }
  return false;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
