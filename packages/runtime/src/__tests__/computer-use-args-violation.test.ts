import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  computerActionFields,
  computerParams,
  describeComputerUseArgsViolation,
} from '../computer-use-codec.js';

/** The error the tool runtime actually holds when arguments fail validation. */
function refusalFor(args: unknown): unknown {
  const parsed = computerParams.safeParse(args);
  assert.equal(parsed.success, false, 'these arguments were supposed to be refused');
  return parsed.error;
}

describe('computer use argument refusals', () => {
  test('tells a call in the wrong dialect what this action does take', () => {
    // The shape from a real run: every key in camelCase, plus two fields that
    // belong to the host's approval projection and were never the model's to
    // send. Naming only what is wrong left it re-sending the same shape.
    const args = {
      action: 'click_element',
      app: 'com.apple.calculator',
      windowId: 8677,
      observationId: 'obs-1',
      approvalClass: 'semantic_mutation',
      rememberForTurnAllowed: false,
    };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.match(said, /does not take/);
    assert.match(said, /This action takes/);
    for (const field of computerActionFields('click_element') ?? []) {
      assert.ok(said.includes(`\`${field}\``), `the correction should name \`${field}\``);
    }
  });

  test('names no fields for an action it does not know', () => {
    const args = { action: 'teleport', app: 'com.apple.calculator' };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.doesNotMatch(said, /This action takes/);
  });

  test('keeps values out of what it says', () => {
    // Arguments can carry typed text, so a refusal may name fields and never
    // their contents.
    const secret = 'hunter2-correct-horse';
    const args = { action: 'type_text', text: secret, windowId: 1 };

    const said = describeComputerUseArgsViolation(refusalFor(args), args);

    assert.ok(said);
    assert.ok(!said.includes(secret), 'a refusal must not echo a typed value');
  });

  test('reads the field list off the schema itself', () => {
    assert.deepEqual(computerActionFields('list_apps'), ['app']);
    assert.equal(computerActionFields('teleport'), undefined);
    assert.equal(computerActionFields(undefined), undefined);
  });
});
