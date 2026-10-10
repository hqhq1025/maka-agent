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

# Desktop window identity

This N-API addon binds Desktop previews to a retained native window. It supports
macOS and Windows. Its opaque identity leases stay in Desktop main. It does not
deliver input, activate windows, or request OS permissions.

| Platform | Identity proof |
| --- | --- |
| macOS | Retain the exact AXWindow and check its WindowServer owner PID and libproc process creation time. Closing or replacing that AXWindow invalidates the lease. |
| Windows | Retain the process handle and creation time, check HWND ownership, and attach a random window property. User32 removes the property when the window is destroyed, including before numeric HWND reuse. UIPI refusal prevents acquisition. |

`listOwnedWindows(pid)` supplements application window discovery with native
ownership checks. It includes owned dialogs and reports geometry without
granting input or proving foreground visibility. The registry holds at most
64 leases; discovery returns at most 128 windows. On macOS, each AX call has a
100 ms timeout. Validation and discovery each share a 250 ms result deadline.
A read retries `kAXErrorCannotComplete` once if the deadline leaves enough time
for another 100 ms read. Other errors do not retry. A late result cannot validate
the lease; all ownership and retained-object checks must still pass. OS calls
can exceed their timeouts, so the deadline is not a hard wall-clock limit.

On Windows, `validateForeground(leaseId, pid, windowId)` also requires the foreground
HWND to match the retained window. A retained top-level window includes its
same-process children, checked with `GA_ROOT`. A retained child stays exact.
A different root, including an owned dialog, fails this check.
A foreign-process child also fails.
The addon does not activate the target.
Selection-preserving input checks this before presentation and immediately before
calling Driver. A focus change refuses that input without releasing a valid
background preview lease. This check does not freeze OS focus during native input.

`applicationIcon(leaseId, pid, windowId)` validates the retained window before
and after reading its application artwork. It returns a 32 by 32 PNG of at
most 64 KiB, or `undefined` when no icon is available. Desktop checks the PNG
signature and dimensions before it sends the image to the existing small icon
entry. This lookup does not capture a window or expose application paths.

macOS reads `NSRunningApplication.icon` or the verified bundle's `NSWorkspace`
icon. Windows reads the exact window's `WM_GETICON` or class icon and returns
no image when neither supplies one. Desktop does not guess an executable name.
Electron's macOS `getFileIcon` uses the content type and can return the same
generic icon for different application bundles.

## macOS preview frames

`startCapture` requires a retained lease and validates it again before delivering
each frame. ScreenCaptureKit captures BGRA at the window's source size. vImage
then scales on the CPU to the requested preview bounds. This avoids the zeroed
frames reproduced when ScreenCaptureKit scaled a Firefox window in the Intel VM.

The source limit is 8,388,608 pixels, 8,192 pixels per side, and 40 MiB including
row padding. Larger sources report capture failure. Desktop requests at most
1280 by 720 pixels at 12 fps. Native delivery permits one pending frame and one
terminal status; the isolated viewer permits one unacknowledged IPC frame.
Stopping or releasing the lease disables queued callbacks before native cleanup.
Main drops frames whose visible pixel area is entirely transparent. Such frames
cannot open the first-frame gate; opaque black frames remain valid. If no visible
frame arrives, the existing preview startup timeout applies.
Windows uses Electron's exact-window video capture after native identity checks.

An open Desktop preview follows fresh observations within the same task. Losing
identity immediately destroys the old capture. The preview waits for a newly
accepted lease before opening another isolated viewer. Each viewer retains its
own target and authorization callback; a late callback cannot authorize its successor.

Closing or hiding the preview, ending the task, releasing its permission, or
locking the screen cancels this request. On macOS, Desktop also checks the
process's Accessibility and Screen Recording permissions. An explicit OS denial
ends the request; restoring permission requires the user to reopen preview.
Temporary AX read failures do not count as an OS permission denial.

## Build

Run `npm run build:desktop-window-identity` on the target platform. macOS requires
Command Line Tools and links system frameworks, including ScreenCaptureKit and
Accelerate. Windows requires Visual Studio C++ Build Tools; the script locates
them with `vswhere`, verifies Electron's import library checksum, and links the
Node delay-load hook. Installed Maka needs no compiler.

The stable Node-API C ABI uses pinned build-only `node-api-headers`. Packaging
copies the matching addon outside ASAR. Linux has no native preview lease.
