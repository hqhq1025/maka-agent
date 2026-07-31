// What a failed Computer Use call tells the model.
//
// The code alone is not a recovery instruction. `unsupported_action` covers a
// key name the host could not parse, an element that does not offer the action,
// and an action this executor has no method for — three different next moves.
// The executor writes the sentence that says which; it used to be dropped.
import test from 'node:test';
import assert from 'node:assert/strict';

import { summarize } from '../computer-use-codec.js';

test('a refusal that declares itself app-text-free reaches the model with its sentence', () => {
  const text = summarize(
    { type: 'press_key' },
    {
      outcome: {
        ok: false,
        error: 'unsupported_action',
        message: 'say Backspace or ForwardDelete rather than delete',
        messageIsAppTextFree: true,
      },
    },
  );
  assert.match(text, /unsupported_action/);
  // Without this the model reads only the code, and the tool description tells
  // it that code means keyboard input is off in this build — so one mistyped
  // key name teaches it the keyboard does not work.
  assert.match(text, /Backspace or ForwardDelete/);
});

test('a refusal that does not declare itself stays a bare code', () => {
  // Absent means withheld. A backend that cannot promise its diagnostics are
  // free of window titles and screen text is treated as one that leaks them.
  const text = summarize(
    { type: 'click_element' },
    {
      outcome: {
        ok: false,
        error: 'target_missing',
        message: 'no window titled "Q3 salary review.numbers"',
      },
    },
  );
  assert.match(text, /target_missing/);
  assert.doesNotMatch(text, /salary/);
});

test('a successful call is unchanged', () => {
  const text = summarize(
    { type: 'click_element' },
    { outcome: { ok: true, tier: 'ax', verified: true } },
  );
  assert.match(text, /computer\.click_element/);
  assert.doesNotMatch(text, /failed/);
});

test('a dispatch that changed nothing does not start with the word ok', () => {
  // Measured on a real run: `cmd+p` came back `ok ... suspected_noop` seven
  // times and the model sent it seven times, then switched to `key` and sent it
  // twice more; another model did the same four times with `ctrl+f2`. It was
  // not guessing at the schema — it read `ok` and believed it.
  const text = summarize(
    { type: 'press_key' },
    {
      outcome: {
        ok: true,
        tier: 'coordinate-background',
        verified: false,
        evidence: { path: 'cg_event_pid', effect: 'suspected_noop' },
      },
    },
  );
  assert.match(text, /delivered but nothing changed/);
  assert.doesNotMatch(text, /computer\.press_key ok/);
});

test('a dispatch that did change something still reads as ok', () => {
  const text = summarize(
    { type: 'set_value' },
    {
      outcome: {
        ok: true,
        tier: 'ax',
        verified: true,
        evidence: { path: 'ax_attribute', effect: 'confirmed' },
      },
    },
  );
  assert.match(text, /computer\.set_value ok/);
});
