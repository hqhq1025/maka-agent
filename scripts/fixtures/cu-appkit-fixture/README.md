# CU AppKit Fixture

Native AppKit fixture for real-machine Computer Use E2E tests.

Build the release `.app`:

```sh
node scripts/build-cu-appkit-fixture.mjs
```

Run the minimal lifecycle smoke:

```sh
node scripts/cu-e2e-appkit-client.mjs smoke
```

The build output is:

```text
.agents-workspace-data/cu-appkit-fixture/CUAppKitFixture.app
```

## Socket Protocol

The executable accepts `--socket <path>` or `MAKA_CU_APPKIT_SOCKET`. The client
uses short paths under `/tmp` so they fit in `sockaddr_un.sun_path`.

Each request and response is one JSON object followed by `\n`.

```json
{"id":1,"method":"show","params":{}}
{"id":1,"ok":true,"result":{"revision":1}}
```

Methods:

- `show`: calls `orderFrontRegardless()` without activating the application.
- `hide`: orders the fixture window out.
- `reset`: restores all controls and counters.
- `snapshot`: returns the current process, window, control, and element state.
- `setFrame`: accepts a Quartz top-left `{x,y,width,height}` rectangle, down to
  the compact `420x280` layout.
- `shutdown`: returns a final snapshot and terminates the fixture.

Snapshots include the revision, PID, accessory activation policy, window
number/visibility/key/main/active state, control values and counters, drag
position, and Quartz top-left rectangles for the window and interactive views.
