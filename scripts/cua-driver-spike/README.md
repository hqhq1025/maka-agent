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

# Cua Driver 0.34.0 integration spike

These harnesses exercise the official Cua Driver SDK through Maka on macOS,
Windows, and Linux. The production selector uses this SDK. The macOS Electron
`--maka` harness and the Windows/Linux `platform-smoke.mjs` harness exercise the real
`selectComputerUseBackend -> computer -> Cua Driver` chain, including screenshots,
background click, Chinese set_value, and independent fixture readback.
Base: Maka `3597abe84356409ccc9fb649c761c1649abe941d`.
Driver release: `cua-driver-rs-v0.34.0`, source `b0968e1b12834e485dda68789541a3cc57664a9f`.

## macOS Electron and packaged-loader checks

From this directory, using Node and Apple's Swift compiler:

```sh
npm ci --workspaces=false --ignore-scripts --no-audit --no-fund
node verify-release.mjs
npm run smoke
mkdir -p results
swiftc Fixture.swift -o results/Fixture
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs --fixture
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs --maka
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs --maka --foreground
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs --maka --double-click
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs --maka --double-click --foreground
node prepare-asar.mjs
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron asar-smoke.cjs
```

The fixture run briefly opens an owned counter window, observes its exact PID/window,
clicks only its Increment button using an AX token and explicit background delivery,
reads the AX state again, and independently reads the application's counter through
stdio. The fixture exits on EOF, `quit`, or its 45-second lifetime limit. No real
document, browser profile, clipboard, or desktop screenshot is used.

The optional `--maka --foreground` run requests foreground delivery for the owned
fixture's semantic click in an unlocked macOS session. The Electron harness checks
the screen lock before launch and supplies the same guard to the production selector.
It requires fresh observation IDs, checks native delivery
evidence, decodes the returned window PNG, and independently confirms the counter
changed from 0 to 1. The following Chinese `set_value` still uses the default AX
write; macOS exposes no foreground mode for it, and its native delivery evidence may
be `background` or `not_applicable`. Neither
run retries an unknown or unexpected effect. The foreground run can take focus.
Background evidence stays in ignored `results/maka.json`; foreground evidence goes
to `results/maka-foreground.json`, including fixture cleanup and any failure.

The `--maka` native harnesses call `tool.impl` directly. The foreground run supplies a
trusted callback scoped to its fixture task; it does not exercise Runtime Host's
interactive grant flow. The Runtime Host integration tests separately cover task
permission, denial, cancellation, revocation, and reuse. A passing native harness
alone cannot establish those authorization behaviors.

The optional `--double-click` run additionally targets an owned AXPress-only custom
view. Two independently observed `click_element` calls must produce two semantic
presses and no mouse gesture. A subsequent `double_click_element` call must produce
the actual AppKit mouse click-count sequence `[1, 2]`, exactly one double-click event,
and no extra semantic press. This independent stdio readback distinguishes the
official dedicated `double_click` route from two single AXPress calls. The model
supplies only the fresh observation/element identity; Driver resolves pointer bounds.
Native delivery evidence and a fresh PNG are checked separately. Reports are
`results/maka-double-click.json` and `results/maka-double-click-foreground.json`.
The harness fails on a refusal or unconfirmed fixture outcome without retrying.

### Composed Host text approval and native execution

The `--host-admission` harness exercises the admission boundary and executor together.
Build its isolated bundle from current source, then run it in an unlocked macOS session:

```sh
node prepare-host-admission.mjs
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/Electron.app/Contents/MacOS/Electron electron-smoke.cjs --host-admission
```

This composes production `ToolRuntime`, `HostClientCapabilityCoordinator`,
`HostInteractionCoordinator`, SQLite interaction/grant storage, `ClientCapabilityChannel`,
both wire decoders, `createDesktopNativeCapabilityProvider`, the foreground admission
context, and the Cua Driver selector. The bundle resolves Maka package exports to current
source and leaves shared `dist` directories untouched. Transport is an in-memory JSON
round trip; the tool-event commit sink records boundary markers. It does not exercise
a model, the composer UI, socket transport, or durable tool-event logging.

The fixture first receives ordinary Computer Use permission through
`interaction.respondByText`. Before foreground approval, the counter and native-click
count must both remain zero. A question containing `批准` must return `unrecognized`
and leave the request pending. The explicit text `允许当前任务使用前台` must create the
task grant; its admitted invocation must send no input and require a new observation.
The next invocation uses that fresh token and the same task grant, sends exactly one
native foreground click, and independently reads counter 1 through fixture stdio.
Native `requestedDelivery` and `actualDelivery`, the captured PNG, grant storage, and
clean process exit are checked separately.

The passing report is `results/host-admission.json`; `results/host-admission-final.png`
shows the native final window. Both are ignored. The script supplies fixed approval
utterances as test inputs. This fixture tests execution and admission; it does not
test a full model conversation with the user.

The dependencies use official GitHub release tarballs for both the SDK and matching
native library. `verify-release.mjs` checks SHA-256 against the release's published
digests; package-lock also pins the installed tarball integrity. This is digest
verification, not a separate Sigstore identity verification. The standalone package
in this directory is Mac arm64 only. Windows and Linux use the platform-specific
optional dependencies in the repository root lockfile.

## Windows and Linux native checks

Install and build from the repository root using Node 24.18.1:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --workspace @maka/core run build
npm --workspace @maka/storage run build
npm --workspace @maka/mcp run build
npm --workspace @maka/runtime run build
npm --workspace @maka/computer-use run build
node scripts/cua-driver-spike/prepare-platform.mjs
```

On Windows, run in a logged-in desktop session with Windows PowerShell and WinForms:

```powershell
node scripts/cua-driver-spike/platform-smoke.mjs
node scripts/cua-driver-spike/platform-smoke.mjs --double-click
```

On Ubuntu, install `xvfb openbox python3-gi gir1.2-gtk-3.0 at-spi2-core dbus-x11`,
then run the fixture in an isolated X11 display and session bus:

```sh
dbus-run-session -- xvfb-run -a sh -c 'export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge; openbox >/dev/null 2>&1 & node scripts/cua-driver-spike/platform-smoke.mjs'
dbus-run-session -- xvfb-run -a sh -c 'export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge; openbox >/dev/null 2>&1 & node scripts/cua-driver-spike/platform-smoke.mjs --double-click'
```

The harness locates only its child fixture PID, requires a PNG window screenshot,
clicks the semantic button token, writes Chinese text, and checks the counter and
field through independent fixture stdio. A successful mutation returns a new
observation and reports background delivery. The Windows legacy-result exceptions
below retain the unknown outcome and require a separate observation before another
action. Both fixtures stop on EOF, `quit`, or 45 seconds.
Reports go to ignored `results/platform-linux.json` or `results/platform-win32.json`.
The dedicated `cua-driver-platform.yml` workflow runs these checks and retains reports.
The Windows VM run does not qualify the GitHub-hosted runner's desktop environment.

On Linux, the optional `--double-click` fixture requires two background semantic
button activations to leave the physical mouse-event count at zero, followed by one
native double click that emits exactly two GTK `BUTTON_PRESS` events and one
`_2BUTTON_PRESS` event. Its report is `results/platform-linux-double-click.json`.
An X11 session without a focus-free pointer backend can refuse this optional
background gesture. The real-model fixture verifies the authorized foreground
recovery path in that environment.
The WinForms fixture counts independent `MouseDown` and `DoubleClick` events.
Its native Windows run passed the gesture assertions in an interactive user session.
Official 0.34.0 reports unknown delivery for background value replacement and double
click, so the report uses `passed-with-unknown-delivery`. This status confirms the
application effects and Maka's unknown-result handling; it does not confirm background delivery.

## Observed results, 2026-10-06 through 2026-10-07

| Check | Result |
| --- | --- |
| SDK/native | Both 0.34.0, contract 0.8.0; official release SHA-256 matched |
| Node 24.18.1 | Import, create, metadata, permissions, list apps, shutdown/destroy passed |
| Electron 43.2.0 / Node 24.18.0 | Same lifecycle and read-only checks passed |
| Owned AppKit window | Exact window discovery and AX observation passed |
| Background semantic click | `route=Accessibility`, `delivery=Background`, `effect=Unverifiable` |
| Independent effect | Fixture reported 0 -> 1; second AX snapshot also showed 1 |
| Focus | Fixture inactive before and after; active PID set equal at those two boundaries |
| Cleanup | Driver shutdown/destroy and fixture process exit completed |
| Linux x86_64 / Node 22.23.1 | Production tool on Xvfb/Openbox/GTK 3 passed; 360x220 screenshot, counter 0 -> 1, exact Chinese field readback |
| Linux native evidence | Click `route=ax`, `effect=unverifiable`; value write `route=ax`, `effect=confirmed`; both `delivery=background` |
| Windows interactive Session 1 | Exact observation and 344x281 PNG passed. Background UIA single click produced counter 1. Chinese value replacement and background double click produced the expected application state, but native delivery remained unknown. Maka retained `outcome_unknown` and required another observation. |
| Windows foreground double click | The Desktop task-admission fixture denied an unapproved call without input. An approved call returned `global_input/foreground` and produced one double click with two mouse presses. This fixture does not include the Host coordinator or a model. |
| Initial macOS foreground attempt | Blocked before input: native returned `ax_window_unresolved` with zero AX windows; an independent `CGSessionCopyCurrentDictionary` query confirmed the macOS session was locked. Fixture counter remained 0 and cleanup exited successfully. |
| Composed Host text approval / macOS foreground | Passed in an unlocked session: ordinary and foreground text grants, ambiguous-text refusal, zero clicks while pending and at the first-grant observation fence, fresh observation, one native foreground click, independent counter 0 -> 1, 640x424 PNG, and clean exit. Native evidence remains `effect=unverifiable`; independent app readback establishes this fixture's effect. |
| macOS dedicated foreground double click | Passed through the dedicated native tool: `route=global_input`, `delivery=foreground`, `effect=unverifiable`; independent AppKit mouse click counts were `[1,2]`, with exactly one double click. Two preceding semantic activations produced no mouse gesture. |
| macOS dedicated background double click | The independent fixture received `[1,2]`, but official 0.34.0 reported `route=synthetic_events`, `delivery=unknown`, `effect=unverifiable`. Maka retained `outcome_unknown` and invalidated the observation. This run does not qualify confirmed background delivery and must not be retried blindly. |
| Linux real-model fixture | The configured Azure model completed Chinese value replacement and a background single click. After an explicit background double-click refusal, the fixture supplied task-scoped text approval through Host. The model observed again and completed one foreground double click. Independent GTK readback confirmed one double click and two mouse presses. |
| Fresh macOSWorld VM identity and cursor | macOS 15.2 x64: retained identity rejected mismatched targets and a closed window while its process remained alive. AX-only observation and one background click placed the blue cursor on the actual desktop; Stop removed it and rejected late completion. |
| Fresh Mac VM independent preview | 480x328 decoded frames progressed, but their pixels were green while the same window's native thumbnail showed changing content. Stop, hide and private-session reuse passed with one Driver observation. Video image quality remains unqualified on this VM. |

Raw local evidence is in ignored `results/node.json`, `results/electron.json`, and
`results/fixture.json`. Focus sampling does not prove absence of transient activation.
The Maka harness also verifies a 640x424 window screenshot and Chinese field value.
The ASAR harness bundles the production adapter and verifies its actual SDK loader.
No stopped native action, signed packaged Maka TCC attribution,
Windows background delivery for value/double-click, Linux Wayland session, or other Linux toolkit has been accepted
by these runs. The Linux run proves native effects in its isolated fixture; it does
not prove absence of transient focus changes in a user's desktop.

The Linux real-model report is `results/real-model-final-linux-validated.json`.
The final run used 10 provider requests and 9 model tool calls. The original report
remains beside it. An offline reevaluation corrected a harness assertion that had
counted a refused native attempt as a successful gesture; no new model request was
needed. This fixture uses production model, Runtime and Host admission code with an
in-memory transport. It does not test the full Composer, socket transport or durable
tool-event log. The harness supplies owner approval text after checking the exact
pending permission request; the model cannot grant itself permission.

For remote macOS native tests, use a one-shot GUI LaunchAgent with
`RunAtLoad=true` and `KeepAlive=false`. Direct SSH launch can attribute TCC to
`sshd-keygen-wrapper`; `launchctl submit` can restart a completed test. Grant the
test application permissions and restart it before acceptance. A decoded frame
counter alone does not prove correct preview pixels; compare changing fixture
content and retain the failed evidence when the image does not change.

An initial fixture attempt queried before the AppKit run loop began and found no window.
The fixture now emits READY from its main queue. An initial standalone ESM Electron entry
did not reach the instrumented entry; the working harness uses CJS bootstrap and imports
the SDK after `app.whenReady()`. The ESM stall's underlying cause is not established.

## Integration conclusions

1. Start with one in-process SDK owned by Desktop. The official guide recommends this
   for applications. Keep Maka's own overlay; direct Cua AppKit overlay requires a
   certified main-thread adapter. Consider private worker only for a demonstrated
   isolation/overlay requirement and after testing native cancellation.
2. Put the executor adapter in `@maka/computer-use`, behind the existing dispatch seam.
   Keep model tools and Runtime Host authorization ownership. The production adapter
   only exposes actions supported by its explicit mapping.
3. Cua's background/foreground delivery is an execution request, not task authorization.
   Maka enforces `never | ask | allow` before native dispatch. In ask mode, the Host's
   independent task grant covers later turns, bound to the Desktop connection and policy
   epoch. The adapter rechecks trusted live authority after queue waits. Runtime Host
   compatibility epoch 208 carries the current exact `computer` identity,
   admission evidence, grant scope and text-response contract.
4. Use the exact platform's 0.34.0 native tool schema. Windows and Linux semantic
   value writes carry explicit delivery, defaulting to background; macOS `set_value` has no
   such input. Do not assume the generated convenience types or extra JS properties
   provide equivalent mode control for every action on every platform.
5. Preserve `effect`, `route`, actual `delivery`, refusal and escalation separately.
   Successful invocation is not proof of application state. Unknown effects must not
   trigger blind foreground retries.
6. `check_permissions` reported host-attributed grants here but did not probe direct
   ScreenCaptureKit. `health_report`'s bundle check compared Electron against
   `com.trycua.driver` and marked it failed. It explicitly says this is not TCC attribution.
   Do not use this standalone bundle check as an embedded-host readiness verdict.
7. Accessibility and pixels have separate admission on macOS. AX-only observation,
   semantic click/double click/value/key actions and sequences can continue without
   Screen Recording; explicit screenshot requests cannot. Post-action capture must
   not silently upgrade an AX-only loop to image capture. Fully relaunch the host
   after changing either OS grant, as required by the pinned embedding guide.
8. Windows requires the user's interactive desktop session and operation-specific
   integrity checks, not administrator access for all normal automation. Linux needs
   the graphical user's session/AT-SPI buses and toolkit accessibility. Wayland
   portal authority is separate from the Maka foreground task grant; move/resize
   is only mapped for X11.
9. `global_input` is a public route, not a synonym for foreground delivery. Admit its
   explicit native delivery and retain missing/unknown facts as unknown outcomes.
   `double_click_element` uses dedicated `double_click`, with no caller-controlled
   count or coordinates; native gesture acceptance remains separate from adapter tests.

## Official recommendations and sources

- [0.34.0 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.0):
  plain SemVer is stable; GitHub prerelease label only prevents the monorepo Latest
  pointer switching products. SDK and native assets are published together.
- [Pinned embedding guide](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md):
  one importing host owns permissions; shutdown before destroying the handle; direct
  child launch preserves TCC responsibility; ASAR/signing and overlay need explicit handling.
- [Pinned workflow](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/WORKFLOW.md),
  [macOS](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/MACOS.md),
  [Windows](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/WINDOWS.md),
  and [Linux](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.0/libs/cua-driver/rust/Skills/cua-driver/LINUX.md):
  fresh window/token, dedicated double/right click, background default, native
  delivery evidence, semantic readback, and platform-specific menu/input routes.
- [SDK guide](https://cua.ai/docs/cua-driver/guides/use-the-sdk): fresh exact window/token,
  explicit mode, then independently verify the postcondition.
- [Permissions](https://cua.ai/docs/cua-driver/guides/permissions): bounded manifests for
  scoped embedded/unattended execution, immutable startup policy, deny by default;
  logged-in profile approval is separate. Dynamic task foreground grants belong in Maka.
- [Platform support](https://cua.ai/docs/cua-driver/concepts/platform-support): Windows,
  Mac and Linux exist; Linux acceptance is compositor/toolkit specific. General Wayland
  cannot promise arbitrary raw background input to unfocused windows.

Typed task foreground authorization and the conversation-first UI A are implemented.
Desktop main/renderer builds, renderer/stories type checks and strict architecture
checks passed. Browser component fixtures verified both foreground approval choices,
Stop clearing the last frame and local policy changes with an unavailable Host.
These fixtures do not constitute a model-driven Electron conversation run.
Remaining native acceptance includes signed packaged host permissions, Wayland,
and stalled-input cancellation. Host lifecycle tests do not
substitute for these native checks. Linux and Windows generic launch remain unexposed
until their action mappings are qualified; the implemented foreground grant alone
does not make launch available.

The current allowlist is one model tool, `computer`, with 13 macOS, 12 Windows
and 11 Linux actions. Generic right click and known-path menu actions remain
unmapped until trusted popup/follow-up window identity is preserved; Windows
UWP Shift+F10 is already expressible with the token-addressed key action.
Separate native acceptance verified the restored cursor on the actual Mac desktop
and its removal after Stop. The independent preview passed capturer lifecycle checks,
but its video pixels remained green on the fresh Mac VM. Live-video image quality
and signed packaged display-media permissions remain unqualified.
