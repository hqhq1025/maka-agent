---
doc_id: computer-use-evidence-classes
title: "Computer Use Evidence Classes"
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

# Computer Use Evidence Classes

Computer Use reports use one of four evidence classes. The class is part of
the qualification boundary and is not descriptive copy.

## real-runtime

A live provider used the production Runtime, Computer Use tool, owned fixture,
and executor path. Provider qualification additionally requires:

- `complete/end_turn`;
- enforced or explicitly reported policy provenance;
- exact provider, model, producer, and live transport identity;
- successful or scenario-expected actions within pre-dispatch budgets;
- fixture process-instance PID/window ownership for every targeted action,
  including both old and replacement instances in restart scenarios;
- observation lineage for every observation-bound action;
- the scenario's exact action sequence when one is declared;
- AX or semantic dispatch evidence for mutations;
- passing expected-state and forbidden-effect assertions.

Missing evidence is invalid or inconclusive. It is never inferred from fixture
state alone.

## fault-injection

The live provider and production Runtime ran, but the named failure was
injected by a wrapper rather than observed from the real host boundary.
For example, injecting `user_intervened` before native dispatch tests recovery
from that signal; it does not establish that the host detects physical input.

Fault-injection reports are useful regression evidence but cannot satisfy a
`real-runtime` provider qualification cell.

## hermetic-protocol

A local protocol server verified provider URL, authentication, model ID,
streaming tool calls, tool-result reinjection, error flags, and final semantic
state. No live provider credential or network model execution is claimed.

## static-contract

Source, schema, or deterministic harness checks only. Mocked Driver outcomes
can establish Maka's adapter behavior, but cannot establish native delivery,
platform permissions, or an application's business effect.

## Current SDK integration evidence

The executor is the official Cua Driver 0.34.0 SDK on macOS, Windows and Linux.
The owned native fixture entry points are documented in
[`scripts/cua-driver-spike/README.md`](../scripts/cua-driver-spike/README.md).
They exercise the production selector and `computer` implementation with
real Driver input and independently read the fixture's state. They do not call
a live provider model, so they cannot qualify as `real-runtime` provider runs.

The composed Host text-admission fixture additionally exercises real grants,
SQLite interaction storage and native foreground input. Its in-memory transport
and tool-commit stand-ins do not establish Composer, socket or durable tool-event
logging behavior; it remains native integration evidence without a live model.

These checks are native integration evidence alongside the four provider
evidence classes. Report the exact OS, architecture, display server, toolkit,
Driver release, actual route/delivery/effect and independent state oracle.
Passing on one platform or toolkit does not qualify another. Before/after
focus samples do not prove the absence of transient foreground activation.

The legacy standalone-executor scenario runners and launchers have been removed.
Their archived results remain historical; they cannot qualify the SDK backend.
There is currently no replacement live-provider qualification launcher. A new
launcher must satisfy [the provider evidence contract](./computer-use-provider-evidence.md)
before claiming a provider matrix pass.

Use `npm run computer-use -- help` for the current validation entry points.
