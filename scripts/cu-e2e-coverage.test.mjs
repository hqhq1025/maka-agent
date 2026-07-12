import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import {
  CU_E2E_ACTION_CONTRACTS,
  CU_E2E_CASE_LANES,
  CU_E2E_REQUIRED_BRANCH_CASES,
  CU_E2E_SEQUENCE_CASES,
  coverageSummary,
  sequenceSummary,
} from './cu-e2e-coverage.mjs';

async function declaredActionTypes() {
  const path = new URL('../packages/core/src/computer-use.ts', import.meta.url);
  const source = await readFile(path, 'utf8');
  const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(file) !== 'CU_ACTION_TYPES') continue;
      const expression = declaration.initializer?.expression ?? declaration.initializer;
      if (!expression || !ts.isArrayLiteralExpression(expression)) continue;
      return expression.elements.map((element) => {
        assert.ok(ts.isStringLiteral(element), 'CU_ACTION_TYPES entries must be string literals');
        return element.text;
      });
    }
  }
  throw new Error('CU_ACTION_TYPES was not found');
}

test('every CuAction has an explicit E2E support contract and atomic case', async () => {
  const declared = await declaredActionTypes();
  assert.deepEqual(Object.keys(CU_E2E_ACTION_CONTRACTS).sort(), declared.sort());
  for (const [action, contract] of Object.entries(CU_E2E_ACTION_CONTRACTS)) {
    assert.match(
      contract.support,
      /^(verified-success|visual-only|state-dependent|expected-fail-closed)$/,
      `${action} has an invalid support classification`,
    );
    assert.ok(contract.atomicCases.length > 0, `${action} must require at least one atomic E2E case`);
    for (const caseId of contract.atomicCases) {
      assert.match(
        CU_E2E_CASE_LANES[caseId] ?? '',
        /^(electron-live|visual-live|appkit-live|backend-contract)$/,
        `${caseId} must declare a valid E2E lane`,
      );
    }
  }
});

test('atomic coverage reports the exact missing cases per action', () => {
  const executed = Object.values(CU_E2E_ACTION_CONTRACTS)
    .flatMap((entry) => entry.atomicCases)
    .filter((caseId) => caseId !== 'button.middle_click');
  const summary = coverageSummary(executed);
  assert.equal(summary.actions.middle_click.covered, false);
  assert.deepEqual(summary.actions.middle_click.missingCases, ['button.middle_click']);
  assert.equal(summary.coveredActions, summary.totalActions - 1);
});

test('lane-scoped coverage does not overclaim backend-contract cases as live', () => {
  const liveCases = Object.entries(CU_E2E_CASE_LANES)
    .filter(([, lane]) => lane === 'electron-live' || lane === 'visual-live')
    .map(([caseId]) => caseId);
  const summary = coverageSummary(liveCases, {
    requiredLanes: ['electron-live', 'visual-live'],
  });
  assert.equal(summary.coveredActions, summary.totalActions);
  assert.equal(summary.branchesCovered, true);
  assert.deepEqual(summary.requiredLanes, ['electron-live', 'visual-live']);
});

test('coverage requires semantic fallback branches independently of action coverage', () => {
  const actionCases = Object.values(CU_E2E_ACTION_CONTRACTS)
    .flatMap((contract) => contract.atomicCases);
  const summary = coverageSummary(actionCases, {
    requiredLanes: ['electron-live'],
  });
  assert.equal(summary.coveredActions, summary.totalActions);
  assert.deepEqual(summary.missingBranchCases, CU_E2E_REQUIRED_BRANCH_CASES);
  assert.equal(summary.branchesCovered, false);
});

test('sequence contracts have unique ids and explicit multi-action oracles', () => {
  const ids = CU_E2E_SEQUENCE_CASES.map((entry) => entry.caseId);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of CU_E2E_SEQUENCE_CASES) {
    assert.ok(entry.actions.length >= 2, `${entry.caseId} must cover a state transition`);
    assert.ok(entry.oracle.length > 0, `${entry.caseId} must declare an oracle`);
  }
  assert.equal(sequenceSummary(ids).covered, true);
});
