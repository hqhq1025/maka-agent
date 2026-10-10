---
doc_id: computer-use-provider-evidence
title: "Computer Use Provider Evidence"
language: en
source_language: en
implementation_status: current
document_status: current
translation_status: source-only
last_verified: 2026-10-07
owners:
  - maka-backend
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Computer Use Provider Evidence

This document defines the evidence contract for real-model Computer Use runs.
The current executor is the official Cua Driver 0.34.0 SDK. Native integration
fixtures validate the adapter separately from a live provider; no provider is
qualified for this backend by the historical results below.

The old standalone-executor scenario runners, launchers, and provider matrix
scripts have been removed. The contract remains the acceptance criterion for a
future SDK-backed provider qualification runner. Current fixture commands are
documented in [`scripts/cua-driver-spike/README.md`](../scripts/cua-driver-spike/README.md).

## Scenario Contract

A qualifying scenario must define:

- an owned fixture appropriate to the target OS and toolkit;
- the exact user prompt and expected state;
- forbidden effects;
- allowed actions and per-action budgets;
- required execution capabilities;
- deterministic state evaluation.

The fixture's independent state oracle must not infer success from Maka's
action reports or the Driver's claimed effect.

## Report Contract

Reports separate four evidence classes:

- `real-runtime`: a live provider model used the production Maka runtime;
- `fault-injection`: a live provider and Runtime exercised a named injected
  failure, but the run cannot qualify as real host evidence;
- `hermetic-protocol`: a fake transport proved protocol behavior;
- `static-contract`: source or schema checks only.

Only `real-runtime` can satisfy a provider matrix cell marked `real`.
Policy-bypassed runs remain visibly labeled and cannot become an unqualified
pass.

Real reports also fail closed unless producer, transport, policy mode, model,
fixture PID/window ownership, latest-observation lineage, action budgets, and
dispatch provenance are explicit. Expected failures must be authorized by the
scenario; a report cannot authorize itself.

A report sanitizer must preserve action types, timing, result codes, aggregate
state, and allowlisted trace fields, while removing coordinates, typed text,
raw UI content, credentials, full URLs, and provider payloads. Do not copy raw
Driver errors into a supposedly content-free report.

## SDK Provider Qualification Gate

A provider launcher must:

1. pin a scenario and the official SDK/native release;
2. run against an owned fixture through the production Runtime and Computer Use backend;
3. collect target PID/window ownership independently before model actions;
4. enforce the scenario action budget before dispatch;
5. record actual Driver route, delivery, effect and observation lineage;
6. emit a sanitized `real-runtime` report with independent fixture and forbidden-effect assertions.

Report macOS, Windows and Linux separately. Linux display-server/toolkit support,
Windows target integrity, background delivery and task authorization are distinct
conditions. An installed native package or passing mock test does not establish
that the target app accepts input.

## Current Host Admission Evidence

The macOS `host-admission.json` fixture passed on Electron 43.2.0 through real
ToolRuntime, Host coordinators, SQLite InteractionStore, ClientCapabilityChannel
wire decoders, Desktop native provider, trusted AsyncLocal admission and the
production Driver. Pending approvals and unrecognized text produced zero clicks;
text foreground approval required a fresh observation before exactly one native
foreground click, independently counted as 1, with a 640x424 PNG and clean exit.

The report is local under `scripts/cua-driver-spike/results/host-admission.json`.
Transport and tool-commit markers are in-memory stand-ins; there is no model,
Composer, socket or durable tool-event log. This qualifies the composed admission
and native fixture path, not a provider matrix cell. Windows native execution,
Wayland, signed TCC attribution and stalled native-input cancellation remain unqualified.

## Historical Qualification Record

The remaining sections preserve measurements from the retired standalone
executor and its deleted runners. Source commits, binary digests, route names,
test counts and statements about the then-current implementation apply only to
that historical revision. The current bundled manifest pins the official Driver
SDK release; it does not contain these historical executor pins.

### Historical Consolidation Findings

Review found that the AppKit producer emitted `traces` while qualification read
`driverTraces`, and the Desktop launcher derived its fixture window allowlist
from the actions being judged. The first mismatch rejected valid AX evidence;
the second allowed circular ownership proof.

Both producers were changed to emit one canonical schema. Desktop fixture identity was
collected independently from the launcher-owned PID and executor window
inventory before model execution. Qualification waits for matching dispatch
traces and requires each target to belong to that independent identity.

Qualification also keeps three fail-closed invariants:

- restart recovery authorizes only the scenario-declared stale
  `set_value / target_missing` result and budgets the required fresh retry;
- disallowed and over-budget model attempts are recorded as canonical failed
  action evidence before the harness rejects them;
- the Desktop launcher and provider matrix call the same real-report validator,
  so a launcher cannot exit successfully for a matrix-invalid report.

The former five-round restart soak was regression-only and never qualified a
provider matrix cell. It was removed with the other legacy executor runners.

### Historical First Real Run

The first qualifying run completed with:

- provider: OpenAI;
- model: `gpt-5.4`;
- evidence class: `real-runtime`;
- tool exposure: direct E2E, with only the production `computer` tool;
- action: one app-scoped `observe`;
- tool latency: 1117 ms;
- total run latency: 7502 ms;
- terminal status: `complete / end_turn`;
- fixture oracle: verification code matched and interaction count remained zero.

The direct E2E tool exposure is deliberate. The default deferred `tool_search`
path remains a separate product contract; the launcher narrows provider
variables while still exercising the production tool implementation, permission
engine, Runtime, Desktop host, and executor backend.

During this run, OpenAI Responses tool continuation exposed a product bug:
server-side storage generated an `item_reference` in the second request without
a `previous_response_id`, so custom Responses endpoints rejected the tool
result. OpenAI provider options now use `store:false`, matching the existing
Codex subscription boundary and keeping function calls/results inline.

A subsequent L1 run completed:

- scenario: `l1-single-click`;
- provider/model: OpenAI `gpt-5.4`;
- actions: two observations and one `click_element`;
- no coordinate or compatibility input action was allowed;
- semantic click latency: 1445 ms;
- total run latency: 26023 ms;
- fixture oracle: primary click count 1, danger click count 0, over-click count
  0;
- terminal status: `complete / end_turn`;
- result: pass.

The run initially failed closed when the user's foreground ChatGPT window
occluded the synthetic target. The fixture host now settles and raises its
layer-0 window with `showInactive()` and `moveTop()` before declaring readiness,
without focusing it or using an always-on-top overlay layer.

### Historical Native WebContent Qualification

The historical executor pin in `apps/desktop/bundled-tools.json` carried source
commit `4a9787d2c7f2fbc6a29b33d691916c6b84543661`, including
`maka-agent/maka-cu#2`, the window-transition follow-up in #3, and the direct
WebContent frame-reflow fix in #4.

The shared synthetic CUA Lab was run ten consecutive times before integration:

- observation exposed one OOP button after unique mirror removal;
- slider requested/readback/business oracle: `42 / 42 / 42`;
- scroll path: semantic `ax_action`, oracle offset `76`;
- OOP click path: `skylight_pid`;
- DOM `MouseEvent.isTrusted`: `true`;
- host local mouse events: one down and one up;
- stale wrong-target count: `0`;
- target application never became frontmost.

A separate live retained-element probe exercised the three refetch outcomes:

- unique replacement: action completed once, wrong target `0`;
- missing replacement: `element_released`, no side effect;
- ambiguous replacement: `element_changed`, no side effect.

After #4, the exact binary then pinned by `apps/desktop/bundled-tools.json`
(`e457a3143544ba8385c489e5259f206d9450feb1c692eb562413b41b9f38de21`)
completed a source-bound five-run Web matrix:

- the probe rebuilt clean source commit `4a9787d2c7f2fbc6a29b33d691916c6b84543661`
  and required the pinned binary bytes to match that build;
- primary AX click oracle was 1 in every run;
- every OOP click used `skylight_pid`, produced `MouseEvent.isTrusted=true`,
  and delivered exactly one host-local mouse down/up pair;
- slider was 42 and scroll offset was 76 in every run;
- unique refetch clicked the intended stale target once, while missing refetch
  had no target or decoy effect;
- all 30 foreground-sentinel spans recorded zero target-frontmost samples, with
  at least 92 samples per span and a maximum 80 ms sample gap.

The deterministic source suite separately forces direct WebContent frame-only
reflow through unique, missing, and ambiguous refetch outcomes, preserves a
distinct renderer process generation, and confirms that native AX frame changes
remain fail closed.

This is native executor evidence, not a provider-model qualification cell. A
future `real-runtime` web scenario must still pass the report contract above.

The same source commit adds `doctor --json`. A release-binary smoke on the
locked-screen state correctly reported permissions granted, all required native
SPIs available, an ad-hoc non-hardened signature, and
`metadataObservation / screenshotObservation / trustedWebContentClick = false`.

Modal and secondary-window routing now have deterministic and live native
functional evidence. Five consecutive CUA Lab runs against the exact pinned
binary completed:

- modal open, app observation routed to the sheet, close, and return to main;
- secondary open, app routing to the frontmost secondary window, exact-window
  button click, semantic scroll, close, and return to main;
- all 30 dispatch paths were `ax_action`;
- button count was 1 and scroll offset reached 140;
- the five per-run records are retained in one aggregate fixture.

The high-frequency foreground sentinel does not pass: across ten modal/secondary
sampling spans it recorded 1,738 target-frontmost samples, with at least 189
samples per span and a maximum 96 ms sample gap. The stage-level before/after
reads had hidden this transient focus theft. Modal/multi-window routing is
therefore functionally qualified but does not yet satisfy the background-focus
contract.

The source includes bounded handling for two measured AppKit races: a newly
listed CGWindow may publish its AXWindow later, and a press may return
`cannotComplete` while creating or closing a window. This five-run fixture did
not exercise the topology-recovery verification arm
(`topologyRecoveryEvidenceCount: 0`), so that behavior remains implementation
and unit-test evidence rather than a live claim.

This is native executor qualification, not a provider-model matrix cell.

The same pin now carries stable AX observation revisions:

- the first tree receives depth-first stable ids;
- matched siblings preserve ids across fresh snapshot tokens;
- new ids begin above the previous maximum;
- post-action observations can render no-change, ordered insert/update changes,
  compressed removed-id ranges, or a full-tree fallback;
- explicit observe continues to render the complete tree.

This is hermetic protocol/static contract evidence, not a provider-model
qualification cell. The native source suite passed 326 tests with 26 explicit
live-test skips, and the host Computer Use suite passed 124 tests. The
modal/secondary evidence above was run after unlock.
