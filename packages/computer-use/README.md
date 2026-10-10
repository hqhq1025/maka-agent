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

# `@maka/computer-use`

Maka's Computer Use executor is Cua Driver 0.34.0. Desktop owns one lazy,
in-process SDK runtime. Runtime owns the model tool, observations, task policy,
and presentation lifecycle. There is no maka-cu executable, JSON-RPC supervisor,
or fallback to the retired maka.cu protocol.

## Installation and lifecycle

`npm ci` installs the SDK and the platform's matching native package from the
official `cua-driver-rs-v0.34.0` GitHub release. Root overrides keep the SDK's
optional native dependencies on the same release URLs. The lockfile records
integrity. No daemon, global installation, or postinstall binary download is needed.

On macOS and Windows, `npm run dev` and Desktop resource builds then run
`scripts/build-cua-driver.mjs`. This script builds the pinned native source with
the fixes in `native/cua-driver/` and installs the library into the resolved
native package. It verifies the source, patches, version, and cached library.
`npm ci` restores the official library; the next build restores the patches.
See [development setup](../../docs/computer-use-development.md) for prerequisites,
repair, upgrades, and rollback. Packaged app users do not need a compiler.

`selectComputerUseBackend()` builds the `computer` tool using
`createCuaDriverBackend()`. First use imports the SDK and verifies its native
version. Initialization failure is reported as unavailable. Electron bundles
`@trycua` and `@ubjs` outside ASAR because the FFI loader opens the native library
directly. Shutdown drains queued work, then calls `shutdown()` and
`uniffiDestroy()` once.

macOS permission prompts belong to Desktop. Preflight checks the native environment
on every invocation. Driver's standalone bundle-identity health result is not a
host-permission verdict. Windows checks UIA availability; Linux checks the display
and AT-SPI session. Target integrity, portal grants and native route permissions
remain per-operation checks. Linux requires a supported glibc/display-server combination;
Wayland does not imply arbitrary background input support.

The host keeps Driver's immutable `standard` mode for routine automation. The
current allowlist does not expose the logged-in browser-profile operations that
require a residual Driver authorization callback. Switching to `unrestricted`
is unnecessary. Driver mode, OS grants and Maka task approval are independent:

| Platform | Readiness and permission boundary |
| --- | --- |
| macOS | Accessibility enables AX observation and token actions. Screen Recording is required for screenshots and pixel verification, not every semantic mutation. Explicit screenshot requests refuse without it; AX-only action loops remain available. After changing either grant, fully quit and reopen Desktop before replacing the runtime. |
| Windows | Desktop must run in the logged-in interactive session, not Session 0. Ordinary UIA/input does not require blanket administrator elevation. UIPI, target integrity and foreground-lock restrictions can still refuse an individual operation. |
| Linux | Run as the graphical desktop user with a reachable session bus, accessibility bus and toolkit accessibility. X11, XWayland and native Wayland have different facilities. A compositor/portal screen or input grant does not grant Maka task foreground authority, and the reverse is also true. |

## Actions and authorization

The initial model schema exposes list, observation/screenshot/wait,
semantic single/double click, value replacement, text insertion, key chords, scroll, advertised
secondary actions, move/resize, and element sequences. Unsupported legacy
`select_text`, ambient `type`/`key`, and minimize are not advertised by this
backend. macOS additionally supports nonactivating app launch. Linux and Windows
launch remain outside the currently qualified action mapping, even with a
foreground grant; users can open the target app before observation. This is an
adapter boundary, not a claim that Driver cannot launch those platforms in the
background: Windows documents native name/AUMID/path launch routes.
Text insertion and key chords can target either an observed element or a pixel
in the current exact-window screenshot. Other coordinate actions are not exposed.
Scroll accepts whole pages (tool scroll_amount 10, 20, ... 100); fractional
page requests refuse rather than silently change distance. Menu expansion is
unavailable; actions can use the elements returned in the window snapshot.

The model receives one `computer` tool with 14 action choices on macOS, 13 on
Windows and 12 on Linux. This is an explicit allowlist, not the Driver's full MCP
catalog. Session lifecycle and permission checks remain private adapter calls.
Browser/page tools duplicate Maka's browser executor; recording/replay, cursor
customization, updates, extension installation, Driver configuration and deprecated
session APIs are not exposed. Keep the official SDK intact rather than maintaining
a native fork just to remove tools the adapter cannot dispatch.

`double_click_element` requests a fixed left double click on the latest observed
element, using the dedicated native `double_click` tool. It shares single click's
target and foreground authorization checks. The model supplies no coordinates,
modifiers or click count. On macOS, Driver prefers an advertised AXOpen action;
otherwise it derives the pointer gesture from the token. Preserve the native
route, effect and delivery result, then inspect the returned fresh observation.
This follows the official
[workflow recommendation](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/WORKFLOW.md#L64);
generic `click(count=2)` can still invoke AXPress on macOS.

Further candidates require their own action contracts and native acceptance:

| Candidate | Value and current boundary |
| --- | --- |
| `verify_state` | Check bounded value/enabled/selected predicates and return satisfied, unsatisfied or unknown. Its observation-only polling does not refresh action tokens. Not yet mapped. |
| `right_click` / `invoke_menu` | Useful for context menus and known application-menu paths. Not yet mapped as independent actions. First preserve trusted popup/dialog identities and native follow-up targets: an X11 override-redirect popup may be absent from ordinary `list_windows`, and current target resolution cannot admit it safely. |
| `drag` | Requires an explicit path and a trusted coordinate mapping. Not exposed. |

These boundaries are based on the official
[`cua-driver-rs-v0.34.0` source](https://github.com/trycua/cua/tree/cua-driver-rs-v0.34.0/libs/cua-driver/rust),
including platform tool handlers and `cua-driver-core/src/expectation.rs`.

Platform parity is not a prerequisite for exposing an action. For example, the
official macOS guide recommends `invoke_menu` for a known menu path because it
owns temporary activation; Windows documents Shift+F10 for some UWP context menus.
Any future mapping must advertise its actual platform capability and use the
corresponding foreground admission. Existing advertised `secondary_action` values
such as `show_menu` remain distinct from a general physical right click.

Prefer fresh exact-window observations and token actions when the application
exposes the intended control. `set_value` replaces a value; it does not promise
caret insertion or submission. `type` maps to official `type_text` and returns
fresh state for verification. Windows UWP Shift+F10 is already
expressible through the existing token-addressed `press_key` combination. Modified
clicks would need a separate foreground contract; holding a modifier across several
tool calls is not an equivalent implementation. Linux move/resize is X11-only;
native Wayland geometry requests refuse before dispatch even if XWayland is present.
Linux menu delivery must be admitted from its actual compositor route, with
foreground authority when temporary activation is required.

When accessibility cannot reach the input surface, `type` and `press_key` accept
`coordinate: [x, y]` instead of `element_id`. Runtime binds the point to the
current screenshot observation and includes it in the consumed-action fingerprint.
The adapter also requires its private native capture proof and checks the original
PNG dimensions. Missing images, resized captures, mixed targets and out-of-bounds
points refuse before input. It passes window-local `x,y` without a desktop offset.
Windows 0.34.0 does not advertise `capture_id` for these two tools, so that private
field is not sent. Foreground grants and unknown-outcome handling remain unchanged.

Windows also accepts `focus: "current"` as the sole input target for `type` and
`press_key`. This preserves a caret or selection without another coordinate click.
It requires explicit foreground delivery, a current screenshot, the task's Host
grant, and a retained native PID/window lease. Desktop also requires that exact
window to be foreground before presentation and immediately before calling Driver.
If another window is foreground, or the retained window identity cannot be
validated, Desktop refuses input and retires the old observation without activating
the target. Restoring focus or reopening the app requires a fresh observation;
zero dispatched input does not make the old selection reusable.
The check does not freeze OS focus during Driver execution. This mode is
unavailable on macOS and Linux.

To replace selected text, focus the editor, send `Ctrl+A` using current focus,
observe the same window again, then type using current focus. Coordinates would
click the editor again and can discard its selection. Unknown results still
require observation before any further input.

The version-matched official
[Computer Use skill](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/SKILL.md)
informs Maka's bundled skill. Maka keeps its own tool contract and Host authority;
the Driver's CLI and full MCP catalog are not added to the model tool surface.

Applicable native requests explicitly select delivery, defaulting to background. Generic
SDK `callTool` is private to the adapter: the model cannot submit arbitrary
driver tool names or arguments. This preserves per-action fields omitted by
0.34.0's generated TypeScript records. The driver still applies its own native
authorization and targeting checks.

`global_input` is a valid public SDK route on these platforms. It describes the
actuator class and can report background or foreground delivery. Never infer
delivery from the route or requested mode. Missing/unknown delivery stays an
unknown outcome; an unexpectedly reported foreground result cannot satisfy a
background-only request. Native escalation advice supplies no permission to retry.

Maka's existing task/content authorization remains in force. Supported semantic
actions may request `delivery: foreground` when the user explicitly asks for
foreground, without first attempting background input. The request still requires
Host authorization. Otherwise, obtain a background refusal or verify a no-op before
requesting foreground. Never reinterpret `outcome_unknown` as a verified no-op.
Native mode support is
action-specific: macOS value replacement, all window actions and element sequences
remain background-only. No background failure silently retries foreground;
uncertain results require fresh observation and planning.

Desktop's user-owned setting is `never | ask | allow`, with `ask` as the default.
Host checks the ordinary Computer Use grant independently of the foreground grant.
In ask mode, one foreground approval covers subsequent turns in the current chat,
bound to its Desktop connection and policy epoch. Forks, another device, reconnection
and policy changes require new authority. A declined request stays in the background
for that epoch. This applies even when ordinary tool approvals are bypassed.

The existing Host interaction store owns the typed foreground grant. Approval waits
happen before device dispatch. Desktop rechecks its local policy after admission and
the adapter rechecks live authority immediately before entering native input. The
model cannot supply that authority or change this user-owned setting through the
settings tool. First foreground admission invalidates existing observations and
returns `reobserve_required`; a fresh observation and a new action can then proceed.
Driver's own standard permission mode does not implement this task consent.
Computer capabilities always declare `hostPathAccess: none`, including for a local
Host. The Desktop supplies its own execution context directory and rejects a Host
directory on Computer calls. Other Desktop capabilities retain their declared path
requirements.
The admission evidence, grant scope, text-response operation and typed activity
metadata require Runtime Host compatibility epoch 209. Desktop and a remote Host
must use matching versions.
The native tool identity is `computer`, with display name `Computer`. The previous
`maka_computer` identity is recognized only when rendering historical calls; it is
not an executable alias. Matching versions preserve exact-tool foreground admission.

The owner-only `interaction.respondByText` operation accepts the session, exact
displayed request ID (`interactionId`) and bounded raw text. Host recognizes only
whole-utterance Chinese, Traditional Chinese and English equivalents for the unique
live Computer Use base or foreground request, then uses the same outcome/grant path
as the buttons. Unrecognized chat follows the normal message queue. Stale or cancelled
requests cannot grant access or revive execution. This does not change global policy
or let a model interpret arbitrary text as authorization.

One queue serializes device operations. A mutation consumes its task-owned
observation; the adapter rejects foreign or stale observations and invalidates
other tasks' snapshots of the same native window. Driver tokens bind the exact
element. Window IDs must fit the existing safe-integer Maka contract; oversized
IDs are refused, never rounded into another target. User-input and lock checks
run again immediately before mutation after any queue wait.

Stopping queued work prevents admission. Once a call has entered native code,
the queue waits for its settlement; an aborted caller gets an unknown outcome
and no automatic retry. This is not an immediate native preemption guarantee.
There is no hard timeout that releases the queue while native input may continue.
Hung native calls and native crashes remain limitations of the in-process choice.
Windows may schedule best-effort focus restoration after an action returns; a result
does not establish that prior focus has been restored or all native cleanup is quiescent.

## User activity and recovery

Cua Driver's MCP, daemon and embedded SDK use the same execution core. Its native
input coordination, target checks and focus protection remain enabled in Maka.
They do not provide a general physical-user-activity event or identify who changed
a window. macOS focus restoration observes application activation, not the actor;
Linux X11 foreground actions may leave the target active. Do not infer uniform
focus restoration or human takeover from the selected transport or delivery mode.
See the pinned [runtime guidance](https://github.com/trycua/cua/blob/b0968e1b12834e485dda68789541a3cc57664a9f/libs/cua-driver/rust/Skills/cua-driver/RUNTIME.md#L48-L54).

Maka checks Electron's global system idle time before explicit foreground mutations. A value
below one second returns `user_intervened` before dispatch. Background actions and
nonactivating macOS launch continue through native target checks without this global
idle gate. This hint cannot distinguish user input from injected input or identify
the affected target; unrelated activity can therefore refuse a foreground action.
A refusal invalidates the active
observation and tells the agent to observe again. It does not pause the task until
the user approves resumption, and observation itself is not blocked by this idle
check. No automatic user-confirmed pause is part of this integration.

The recovery contract is to expose the real refusal or uncertain outcome, invalidate
unusable observations, and let the agent inspect the current window before choosing
its next action. `path=none` proves no agent input was dispatched; it does not prove
that the user or application left the window unchanged. Advice to reuse an observation
requires both its original live session lease and the exact retained frame. Partial,
cancelled and unknown actions must not be automatically replayed. The driver observer
reports action/session/authorization events after invocation; it is not an input
watcher or a source of live human intent.

When the SDK explicitly refuses input because its target or token expired, the adapter
retires the private observation and notifies Runtime. A failed replacement capture
cannot restore the old frame. Argument mismatches and other no-input refusals do not
by themselves prove that the observed window changed.

## Results

Action invocation, reported delivery, and observed business effect are separate.
Unverifiable effects remain unverified; partial/malformed/unknown outcomes fail
without claiming zero input. Only explicit refusal reports `path=none`. A fresh
post-action capture does not upgrade the action to confirmed automatically.
Static AX text without actionable tokens remains model-visible read-only context;
only tokens in the actionable list may be sent back as targets. Full accessibility
trees and field values are excluded from transcript activity metadata. The existing
durable `modelProjection` replay retains model-visible observations; this is a separate
storage contract, not a claim that all accessibility content is ephemeral.
Desktop transports the executor's exact error code and safe native summary separately
from model content. Host accepts that summary only from the authenticated native
Computer Use binding and requires it on every native result, including early refusals.
Failed and unknown results remain failures in tool history and telemetry.
An exact-window screenshot may remain usable when the native accessibility tree is
explicitly empty or Windows reports `msaa_fallback_partial`. These degraded captures
expose no accessibility text or actionable tokens. A partial MSAA tree cannot prove
checked state. Other degraded
identity or route failures remain refusals.

## Conversation presentation

Runtime attaches `ComputerUseActivity` to the tool result and terminal event. It
copies bounded app, window and control names from the bound observation before
dispatch. It excludes model-written labels, field values and later element lookups.
Host accepts this metadata only from the authenticated native Computer Use binding.
The call ID binds the same snapshot to live display and durable transcript recovery.

Computer action rows show only the action and observed target name by default.
PID, elapsed time and native diagnostics stay inside the operation log. Unverified
effects use a neutral icon; delivery completion alone does not show a success check.
The record preserves whether a foreground grant sent input. Historical calls without
typed evidence retain an unknown result state instead of inferring success from text.

Desktop projects accepted observations and action results into an ephemeral feed
for the conversation status and optional Computer tab. Opening that tab subscribes
to the current task and shows its latest accepted screenshot without refreshing
executor observations. The preview labels the last captured window and timestamp,
and reports delivery only from native evidence. Independent live video requires
an explicit Start live preview action. macOS captures BGRA at the source size
and scales with vImage before sending bounded frames to the isolated viewer.
This avoids the zeroed NV12 and scaled Firefox BGRA frames reproduced in the VM.
An entirely transparent frame cannot open the first-frame gate or consume IPC
credit. Opaque black remains valid; the existing startup timeout handles a
capture that never supplies visible pixels.
Windows uses Electron's exact-window video source after native identity checks.

The sandboxed viewer holds an accepted-window identity lease. It stays hidden
until video presents its first frame; the panel retains its last screenshot
during startup. Unsupported identity binding reports unavailable without a
desktop or title-based fallback. Hiding the panel revokes only its preview lease; Stop task
remains a separate control. The private media session is reused per Desktop window;
late starts or old capturer teardown cannot restore or revoke a successor's preview.
Live video requires the native macOS or Windows identity helper. Linux keeps the
accepted screenshot view. The conversation shows a 16-pixel application icon,
read from the retained native application or window, plus a short action.
That entry opens the Computer tab and does not display a screenshot.

Computer work starts collapsed, including during execution. Readers can expand
or collapse it while new actions arrive. The expanded process has a bounded
scroll area; individual action diagnostics remain closed. Final replies stay
outside the process disclosure.

The agent cursor retains Maka's existing glyph. Cua's AppKit overlay is unavailable
in an arbitrary direct SDK runtime without its certified main-thread adapter; an
overlay alone does not justify changing executor transport. Presentation geometry
is admitted only when exact window geometry agrees before and after observation,
including AX-only observations, with
Windows physical pixels converted to Electron DIP. Unknown, offscreen or minimized
targets suppress the cursor; lock and Stop clear it. This decoration neither moves
the physical pointer nor establishes action delivery or effect. Native visual
acceptance is tracked separately from schema and lifecycle tests.

Collapsed tool rows use deterministic action categories such as checking a window,
filling content and clicking. Live arguments come from `argsPreview` when full `args`
are unavailable. Element IDs and raw action names remain in expanded details; a
previous call's application is not attributed to a new call without evidence.

Subscriptions bind the renderer, task and Runtime Host epoch. Navigation, provider
replacement and task retirement invalidate older callbacks. Switching target windows
clears the previous frame. Frames are retained only while subscribed, never written
to Session persistence, and bounded to 8 MiB per task across at most 32 tasks.

Stop prevents new dispatches and clears the preview immediately. While a native
call remains unsettled the status stays stopping; only its settlement can mark the
task stopped. An action returning is distinct from the whole task completing.
The observation hook cannot delay execution, and a late stopped or retired capture
cannot restore pixels. Foreground requests remain a separate authorization contract.

## Validation

- `npm --workspace @maka/computer-use run build`
- `node --test packages/computer-use/dist/__tests__/cua-driver-backend.test.js`
- Runtime Computer Use tests and Desktop host tests cover surrounding contracts.
- `scripts/cua-driver-spike/README.md` documents the real Electron -> Maka tool ->
  Cua Driver -> AppKit counter/text fixture and an ASAR native-load fixture.

The 2026-10-07 full Desktop acceptance uses Composer, Host socket, AgentRun,
Azure GPT-5.6 Sol, native Driver calls and durable history. Windows completed
Firefox registration, Notepad++ long-document editing, VLC playback controls,
SumatraPDF search and Writer replacement/save/reopen. Mac completed Firefox
registration, Preview PDF search and a new Writer document with a nested path
sheet. Both Writer runs used isolated candidate SDKs built from the fixed
0.34.0 source; the repository dependency pin remains official 0.34.0.

Mac also qualified one dedicated Finder double click through a single official
0.34.0 SDK instance. One call opened the specified PDF in Preview; subsequent
observation confirmed its title and first page. The original result remained
`unverifiable`, so the independent effect does not become confirmed delivery.
Desktop reload and history replay preserve the original events without new
model requests. Local operator evidence is indexed in
`docs/local/cua-driver-todo-handoff.md`.

Earlier native fixtures have the following narrower scope:

- macOS arm64 development Electron and Linux x64 under X11 (Xvfb, Openbox,
  GTK/AT-SPI) passed observe, screenshot, background click and CJK value replacement
  with independent application readback.
- The Linux real-model fixture passed Chinese value replacement, one background
  click, a pre-input background double-click refusal, Host text approval, fresh
  observation and one foreground double-click gesture. Its transport and event
  ledger are in memory; it does not qualify Composer, socket transport, a full
  AgentRun or durable tool-event storage.
- The Windows 11 Session 1 fixture passed observation, PNG and UIA click.
  Independent readback confirmed CJK value replacement and a real double click.
  Official 0.34.0 reports unknown delivery for those two background actions;
  Maka preserves `outcome_unknown` and requires observation before continuing.
  A separate foreground gesture passed Desktop task admission. This fixture
  does not include the Host coordinator or a model.
- The fresh macOS 15.2 x64 VM passed retained-window identity, rejection after
  target closure, AX-only cursor geometry, one background click and actual
  desktop cursor visibility. Stop and simulated presentation locking removed
  the overlay. Preview Stop, hide and private-session reuse passed. Real locking
  closed the capturer when identity failed, before the Electron lock event.
  The revised real-lock harness passed this event order. The earlier Electron
  video produced green pixels; the replacement BGRA path displayed changing
  Firefox content in the actual Desktop sidebar. Advancing frame counts alone
  do not prove live image quality.

Earlier Mac double-click diagnostics loaded duplicate SDK libraries, and a
later attempt stopped at locked-screen capture. Those reports remain separate
from the successful clean official-SDK run.
Two single activations are not double-click proof. Window close/recreate with
actual WindowServer ID reuse, Wayland, signed packaged TCC attribution and
immediate stalled-input cancellation remain unverified.

The conversation status, optional window preview and Stop task control are
implemented. Foreground consent uses the existing approval surface and a separate
task grant. Desktop builds, focused tests, renderer/stories type checks and strict
renderer architecture checks passed. Browser fixtures verified approval decisions,
Stop clearing the preview and local policy updates while the selected Host is
unavailable. See `scripts/cua-driver-spike/README.md` for fixture details and
evidence limits.

The composed Host admission fixture passed on Electron 43.2.0: pending approvals
and unrecognized text produced no clicks; text approval first returned
`reobserve_required`, then fresh observation allowed exactly one native foreground
click, independently counted as 1, with a 640x424 PNG and clean exit. This supersedes
the earlier locked-screen attempt as the current macOS foreground evidence. The
harness uses real Host grants, SQLite and the Desktop/Driver chain, but in-memory
transport and tool-commit stand-ins; it does not qualify a model, Composer, socket
or durable tool-event log. See the fixture README and ignored
`scripts/cua-driver-spike/results/host-admission.json`.
