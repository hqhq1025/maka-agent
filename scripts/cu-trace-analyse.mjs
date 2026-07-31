#!/usr/bin/env node
// What confused the model.
//
// `MAKA_CU_DEBUG_LOG` records every Computer Use call a real run made:
// arguments verbatim, result untruncated, interleaved with the executor's own
// dispatch trace. Reading one by hand tells you what happened; reading twenty
// tells you what the tool surface keeps doing to models.
//
// This looks for the shapes that mean a model was stuck rather than working:
//
//   repeated       the same call, twice or more, unchanged. It read the reply
//                  and had no better idea than to send it again.
//   thrash         the same action, different arguments each time — it is
//                  guessing at the schema, not at the screen.
//   refused        which codes came back, and what the model did next. A code
//                  followed by a different action is recovery; a code followed
//                  by the same action is a dead end.
//   blind          a mutating action with no observation in front of it.
//   abandoned      the turn ended within one call of a refusal.
//   cost           calls per task, and how much of that was spent recovering.
//
//   node scripts/cu-trace-analyse.mjs /tmp/cu-desktop-scenarios/*.trace.jsonl
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (files.length === 0) {
  console.log('usage: node scripts/cu-trace-analyse.mjs <trace.jsonl...>');
  process.exit(2);
}

/** The call as the model asked for it, with the volatile parts removed. */
function signature(call) {
  const args = { ...(call.args ?? {}) };
  // An observation id changes every turn by design; two calls that differ only
  // there are the same call as far as the model's intent goes.
  delete args.observation_id;
  return `${args.action ?? call.action ?? '?'} ${JSON.stringify(args)}`;
}

function classify(record) {
  // The journal carries both the tool-call records and the executor's dispatch
  // trace. Only the former is a decision the model made.
  if (record.kind === 'driver') return null;
  const payload = record.payload ?? record;
  const args = payload.args ?? payload.input ?? payload.arguments ?? {};
  const result = payload.result ?? payload.output ?? payload.text ?? '';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  const failed = /failed:\s*([a-z_]+)/.exec(text);
  return {
    action: args.action ?? payload.action ?? '?',
    args,
    signature: signature({ args }),
    failed: failed?.[1] ?? null,
    text,
  };
}

const report = [];
for (const file of files) {
  const raw = await readFile(file, 'utf8').catch(() => '');
  if (!raw.trim()) {
    report.push({ file, empty: true });
    continue;
  }
  const calls = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(classify)
    .filter(Boolean);

  const seen = new Map();
  const repeated = [];
  for (const call of calls) {
    const n = (seen.get(call.signature) ?? 0) + 1;
    seen.set(call.signature, n);
    if (n === 2) repeated.push(call.signature);
  }

  const byAction = new Map();
  for (const call of calls) {
    if (!byAction.has(call.action)) byAction.set(call.action, new Set());
    byAction.get(call.action).add(JSON.stringify(call.args));
  }
  const thrash = [...byAction.entries()]
    .filter(([, shapes]) => shapes.size >= 3)
    .map(([action, shapes]) => `${action}×${shapes.size} shapes`);

  const refusals = calls.filter((c) => c.failed);
  const deadEnds = refusals.filter((c, i) => {
    const at = calls.indexOf(c);
    const next = calls[at + 1];
    return next && next.action === c.action;
  });
  const blind = calls.filter((c, i) => {
    if (
      !/click_element|set_value|press_key|select_text|scroll_element|element_sequence/.test(
        c.action,
      )
    )
      return false;
    const before = calls.slice(0, i).reverse();
    const lastObserve = before.find((p) => /observe|screenshot/.test(p.action));
    return !lastObserve;
  });
  const abandoned =
    refusals.length > 0 && calls.length > 0 && calls[calls.length - 1]?.failed !== null;

  report.push({
    file,
    calls: calls.length,
    refusals: refusals.length,
    codes: [...new Set(refusals.map((c) => c.failed))],
    repeated,
    thrash,
    deadEnds: deadEnds.length,
    blind: blind.length,
    abandoned,
    actions: [...new Set(calls.map((c) => c.action))],
  });
}

for (const r of report) {
  console.log(`\n=== ${basename(r.file)}`);
  if (r.empty) {
    console.log(
      '    (no trace — the run wrote nothing, which usually means MAKA_CU_DEBUG_LOG was not set)',
    );
    continue;
  }
  console.log(
    `    ${r.calls} calls, ${r.refusals} refused${r.abandoned ? ', ended on a refusal' : ''}`,
  );
  console.log(`    actions: ${r.actions.join(' ')}`);
  if (r.codes.length > 0) console.log(`    codes: ${r.codes.join(' ')}`);
  if (r.repeated.length > 0) {
    console.log(`    REPEATED — the same call sent again after reading the reply:`);
    for (const sig of r.repeated.slice(0, 4)) console.log(`      ${sig.slice(0, 140)}`);
  }
  if (r.thrash.length > 0)
    console.log(`    THRASH — guessing at the schema: ${r.thrash.join(', ')}`);
  if (r.deadEnds > 0)
    console.log(`    DEAD END — ${r.deadEnds} refusal(s) followed by the same action again`);
  if (r.blind > 0)
    console.log(`    BLIND — ${r.blind} mutating call(s) with no observation in front`);
}

const total = report.filter((r) => !r.empty);
if (total.length > 0) {
  const calls = total.reduce((n, r) => n + r.calls, 0);
  const refused = total.reduce((n, r) => n + r.refusals, 0);
  console.log(
    `\nacross ${total.length} runs: ${calls} calls, ${refused} refused (${Math.round((refused / Math.max(calls, 1)) * 100)}%), ` +
      `${total.reduce((n, r) => n + r.repeated.length, 0)} repeated, ${total.reduce((n, r) => n + r.deadEnds, 0)} dead ends`,
  );
}
