#!/usr/bin/env node
/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

const commands = {
  'verify-release': 'verify-release.mjs',
  'prepare-platform': 'prepare-platform.mjs',
  'platform-smoke': 'platform-smoke.mjs',
};

const [command, ...args] = process.argv.slice(2);
if (!command || ['help', '--help', '-h'].includes(command)) {
  console.log(`Computer Use embeds official Cua Driver 0.34.0 from npm ci.

Commands:
  verify-release    Verify the SDK and macOS arm64 release archive digests.
  prepare-platform Bundle the built Maka adapter for the platform fixture.
  platform-smoke   Run the owned Linux/Windows native fixture.

See scripts/cua-driver-spike/README.md for build prerequisites, display setup,
macOS Electron validation, ASAR validation, and acceptance limitations.`);
} else if (Object.hasOwn(commands, command) && args.length === 0) {
  await import(new URL(`./cua-driver-spike/${commands[command]}`, import.meta.url).href);
} else {
  console.error('Unknown Computer Use command or arguments. Run npm run computer-use -- help.');
  process.exitCode = 1;
}
