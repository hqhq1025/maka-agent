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

# Develop and update Computer Use

The source checkout installs Cua Driver 0.34.0 from locked official packages.
Desktop development and resource builds apply Maka's macOS and Windows native
fixes from source. Packaged app users need no Rust or C++ toolchain.

## Build from a checkout

Use Node 24.18.1 and npm 11.19.0. On macOS, install Xcode Command Line Tools.
On Windows, install Visual Studio Build Tools with Desktop development with C++
and a Windows SDK. Git, tar, and rustup must be available on PATH. Install the
Rust 1.97.1 toolchain for the machine's native architecture.

1. Install the pinned Rust toolchain:

   ```sh
   rustup toolchain install 1.97.1 --profile minimal
   ```

2. Install the locked workspace dependencies:

   ```sh
   npm ci
   ```

3. Start Desktop:

   ```sh
   npm run dev
   ```

The first start downloads the pinned Cua source and compiles the native SDK.
Later starts verify and reuse `.cache/cua-driver/`. To build this dependency
without starting Desktop, run `npm run build:cua-driver`.

Use a Node process with the architecture you intend to run. The builder selects
`x86_64` or `aarch64` from Node and passes the corresponding Rust target explicitly.
It supports native macOS and Windows builds. Cross-compiling is not qualified.
Linux uses the official native library and does not run this source build.

On macOS, allow Accessibility and Screen Recording for the actual Desktop app
when required. Fully quit and reopen that app after changing its grants. A Node
or Electron process launched from a different path does not inherit those grants.
On Windows, launch Desktop in the logged-in interactive session.

## Update, repair, and rollback

After pulling this branch, close Desktop and run `npm ci`, then `npm run dev`.
Use the same sequence after an incomplete install or a missing native library.
`npm ci` replaces any manually modified library with the locked official package.
The next Desktop build restores the verified native patches from cache.

If the builder reports a damaged library cache, close Desktop and run
`npm run build:cua-driver -- --rebuild`. A source checksum mismatch stops the build.
Remove the reported cache directory only after its build processes have exited,
then retry to download the source again.

A `building` directory prevents concurrent builds from overwriting one another.
Its `owner.json` records the process and start time. If a build was interrupted,
confirm that both Node and its Cargo children have exited before removing that
`building` directory. The builder does not guess whether a compiler is still using it.

To undo a dependency upgrade, restore the previous package manifests and
`package-lock.json` together, then run `npm ci`. Changing the version or tarball
URL alone is insufficient for an offline rollback. An offline install also needs
the exact locked packages in the npm cache.

Do not upgrade only the native package. Maka checks the native SDK version before
dispatching tools. The patch builder independently checks both package versions
before compilation and again before installing the result.

For an intentional upgrade, update the SDK and native package pins, lockfile,
patch manifest, backend version gate, and license inventory. Rebuild on each
platform and repeat the affected GUI workflows before distributing the result.

## Qualification recorded on 2026-10-10

The installation matrix used macOS 15.2 x64 and Windows x64 VMs with Node 24.18.1.
It covered fresh and repeat installation, missing or damaged native files,
0.34.0 to 0.34.1 upgrades, and rollback with the saved 0.34.0 lockfile.
The branch remains pinned to 0.34.0; a working 0.34.1 import does not qualify
Maka's patches or GUI workflows on that version.

Windows checks included the SDK's real metadata, permission query, and a screenshot
of an owned Notepad++ test window. The VM ran with High integrity; this does not
establish behavior against targets with higher integrity than Desktop.
The isolated macOS processes correctly reported missing OS grants. Their metadata
and install checks passed, but those processes did not pass screenshot acceptance.
Apple Silicon and Windows ARM64 require separate runtime qualification.
