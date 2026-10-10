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

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { buildDesktopWindowIdentity } from './build.mjs';

if (process.platform !== 'darwin') throw new Error('Owned identity verification requires macOS');
const root = dirname(fileURLToPath(import.meta.url));
const native = createRequire(import.meta.url)(await buildDesktopWindowIdentity());
const fixture = join(root, 'build', 'identity-fixture');
await promisify(execFile)('xcrun', ['swiftc', join(root, 'identity-fixture.swift'), '-o', fixture]);
const child = spawn(fixture, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
const iter = lines[Symbol.asyncIterator]();
const timeout = AbortSignal.timeout(10_000);
timeout.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
let lease;
try {
  const ready = (await iter.next()).value?.match(/^READY (\d+) (\d+)$/);
  assert.ok(ready, 'owned fixture must report its OS PID and window ID');
  const [, pidText, windowText] = ready;
  const pid = Number(pidText),
    windowId = Number(windowText);
  const begin = performance.now();
  lease = native.acquire(pid, windowId);
  assert.equal(
    typeof lease,
    'string',
    'Accessibility must already permit reading the owned test window',
  );
  const acquiredMs = performance.now() - begin;
  const validateBegin = performance.now();
  assert.equal(native.validate(lease, pid, windowId), true);
  const validateMs = performance.now() - validateBegin;
  assert.equal(native.validate(lease, pid + 1, windowId), false);
  assert.equal(native.validate(lease, pid, windowId + 1), false);
  child.stdin.write('close\n');
  assert.equal((await iter.next()).value, 'CLOSED');
  assert.equal(
    native.validate(lease, pid, windowId),
    false,
    'closed window cannot validate even while its process lives',
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, pid, windowId, acquiredMs, validateMs, closedWindowRejected: true })}\n`,
  );
} finally {
  if (lease) native.release(lease);
  native.dispose();
  lines.close();
  child.stdin.end('quit\n');
  if (child.exitCode === null) await once(child, 'exit');
}
