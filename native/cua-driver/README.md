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

# Cua Driver native patches

These patches preserve the native fixes used by Maka after a fresh clone or
`npm ci`. The builder downloads the fixed upstream source, verifies its hash,
applies the platform's patches, and builds `cua-driver-sdk` with Rust 1.97.1.
The native patches live outside `patches/`, which belongs to `patch-package`.
The manifest pins Cua Driver 0.34.0 to upstream commit
`b0968e1b12834e485dda68789541a3cc57664a9f`.

| Patch | Corrected behavior |
| --- | --- |
| `macos-sheet-observation.patch` | Include exact AXSheets in window discovery and observation. |
| `macos-sheet-input.patch` | Resolve inputs against the observed sheet and preserve the owning window identity. |
| `windows-owned-dialog.patch` | Include visible untitled dialogs with an owner in the same process. |
| `windows-foreground-child.patch` | Recognize a focused child of the selected root window when checking foreground input. |

The modified `platform-macos` and `platform-windows` crates inherit the upstream
workspace's MIT license. The `cua-driver-sdk` crate also inherits MIT. Keep the
[MIT notice](../../apps/desktop/resources/licenses/cua-driver/LICENSE-MIT.txt).
Maka does not modify the separate MPL-2.0 Node bridge or runtime; their notices
remain in the packaged application.

The [development guide](../../docs/computer-use-development.md) explains build,
repair, and upgrade commands. `scripts/build-cua-driver.test.mjs` checks package
ownership and cache boundaries. Native builds and GUI acceptance are distinct:
a successful build does not grant macOS Accessibility or Screen Recording.

When upstream adopts a fix, remove its patch only after the same native behavior
passes on the replacement version. Update the manifest, SDK and native package
versions, lockfile, backend version gate, and license inventory together.
