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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

const builder = await readFile(new URL('./build-cua-driver.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = 'original native fixture\n';
const candidate = 'patched native fixture\n';
const configurations = [
  {
    platform: 'darwin',
    arch: 'x64',
    suffix: 'darwin',
    rustTarget: 'x86_64-apple-darwin',
    library: 'libcua_driver_sdk.dylib',
  },
  {
    platform: 'win32',
    arch: 'arm64',
    suffix: 'win32',
    rustTarget: 'aarch64-pc-windows-msvc',
    library: 'cua_driver_sdk.dll',
  },
];

function command(executable, args, options = {}) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function fixture(t, configuration = configurations[0]) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-builder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'checkout');
  const sdk = join(root, 'node_modules/@trycua/cua-driver');
  const name = `@trycua/cua-driver-${configuration.suffix}-${configuration.arch}${configuration.platform === 'win32' ? '-msvc' : ''}`;
  const native = join(root, 'node_modules', name);
  const source = join(directory, 'source/upstream/libs/cua-driver/rust');
  const bin = join(directory, 'bin');
  for (const path of [
    sdk,
    native,
    source,
    bin,
    join(root, 'scripts'),
    join(root, 'packages/computer-use'),
    join(root, 'native/cua-driver'),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(root, 'scripts/build-cua-driver.mjs'), builder);
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({ name: '@trycua/cua-driver', version: '0.34.0' }),
  );
  await writeFile(join(native, 'package.json'), JSON.stringify({ name, version: '0.34.0' }));
  await writeFile(join(native, configuration.library), original);
  await writeFile(join(source, 'fixture.txt'), 'before\n');
  // Node executes the pinned-toolchain argument as this fixture script. The
  // builder still spawns a real process and uses the real filesystem and tools.
  await writeFile(
    join(source, '+1.97.1'),
    `
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
(async () => {
  assert.equal(await fs.readFile('fixture.txt', 'utf8'), 'after\\n');
  const args = process.argv.slice(2);
  assert.ok(args.includes('--locked'));
  assert.ok(args.includes('--release'));
  const target = args[args.indexOf('--target') + 1];
  assert.equal(target, process.env.FIXTURE_RUST_TARGET);
  if (process.env.FIXTURE_ACTION === 'wait') {
    console.log('COMPILER_READY ' + process.pid);
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
  if (process.env.FIXTURE_ACTION === 'replace-version') {
    const path = process.env.FIXTURE_NATIVE_PACKAGE;
    const metadata = JSON.parse(await fs.readFile(path, 'utf8'));
    metadata.version = '0.34.1';
    await fs.writeFile(path, JSON.stringify(metadata));
  }
  if (process.env.FIXTURE_ACTION === 'fail') process.exit(42);
  const output = join(process.env.CARGO_TARGET_DIR, target, 'release');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(join(output, process.env.FIXTURE_LIBRARY), ${JSON.stringify(candidate)});
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
  );
  const cargo = join(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  try {
    await link(process.execPath, cargo);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(process.execPath, cargo);
  }
  const archive = join(directory, 'source.tar.gz');
  const tar = await command('tar', ['-czf', archive, '-C', join(directory, 'source'), 'upstream'])
    .completed;
  assert.equal(tar.code, 0, tar.stderr);
  const patch =
    '--- a/libs/cua-driver/rust/fixture.txt\n+++ b/libs/cua-driver/rust/fixture.txt\n@@ -1 +1 @@\n-before\n+after\n';
  await writeFile(join(root, 'native/cua-driver/fixture.patch'), patch);
  const manifest = {
    version: '0.34.0',
    sourceCommit: 'a'.repeat(40),
    sourceSha256: sha256(await readFile(archive)),
    rustToolchain: '1.97.1',
    platforms: {
      [configuration.platform]: {
        packageSuffix: configuration.suffix,
        library: configuration.library,
        patches: [{ file: 'fixture.patch', sha256: sha256(patch), directory: '.' }],
      },
    },
  };
  await writeFile(join(root, 'native/cua-driver/manifest.json'), JSON.stringify(manifest));
  const identity = sha256(
    JSON.stringify({
      manifest,
      platform: configuration.platform,
      arch: configuration.arch,
      rustTarget: configuration.rustTarget,
    }),
  );
  const cache = join(root, '.cache/cua-driver', identity);
  await mkdir(cache, { recursive: true });
  await copyFile(archive, join(cache, 'source.tar.gz'));
  const bootstrap = join(root, 'run.mjs');
  await writeFile(
    bootstrap,
    `
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(configuration.platform)} });
Object.defineProperty(process, 'arch', { value: ${JSON.stringify(configuration.arch)} });
const { buildCuaDriver } = await import('./scripts/build-cua-driver.mjs');
try {
  const result = await buildCuaDriver({ rebuild: process.argv.includes('--rebuild') });
  console.log('BUILD_RESULT ' + JSON.stringify(result));
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
`,
  );
  const env = {
    ...process.env,
    PATH: bin + delimiter + process.env.PATH,
    FIXTURE_RUST_TARGET: configuration.rustTarget,
    FIXTURE_NATIVE_PACKAGE: join(native, 'package.json'),
    FIXTURE_LIBRARY: configuration.library,
    CARGO_BUILD_TARGET: 'unrelated-inherited-target',
  };
  const run = (action = '', args = []) =>
    command(process.execPath, [bootstrap, ...args], {
      cwd: root,
      env: { ...env, FIXTURE_ACTION: action },
    });
  const seedCache = async () => {
    await writeFile(join(cache, configuration.library), candidate);
    await writeFile(
      join(cache, 'receipt.json'),
      JSON.stringify({
        identity,
        version: manifest.version,
        sourceCommit: manifest.sourceCommit,
        rustTarget: configuration.rustTarget,
        sha256: sha256(candidate),
      }),
    );
  };
  return {
    directory,
    root,
    sdk,
    native,
    cache,
    library: join(native, configuration.library),
    configuration,
    run,
    seedCache,
  };
}

for (const configuration of configurations) {
  test(`build and restore ${configuration.platform}/${configuration.arch} with an explicit target`, async (t) => {
    const f = await fixture(t, configuration);
    const built = await f.run().completed;
    assert.equal(built.code, 0, built.stderr);
    assert.equal(await readFile(f.library, 'utf8'), candidate);
    const receipt = JSON.parse(await readFile(join(f.cache, 'receipt.json')));
    assert.equal(receipt.rustTarget, configuration.rustTarget);
    await writeFile(f.library, original);
    const restored = await f.run('fail').completed;
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(await readFile(f.library, 'utf8'), candidate);
    assert.equal(
      (await readdir(f.native)).some((name) => name.endsWith('.tmp')),
      false,
    );
  });
}

test('refuse a linked native package outside the checkout without changing it', async (t) => {
  const f = await fixture(t);
  await f.seedCache();
  const external = join(f.directory, 'external-native');
  await mkdir(external);
  for (const name of ['package.json', f.configuration.library])
    await copyFile(join(f.native, name), join(external, name));
  await rm(f.native, { recursive: true });
  await symlink(external, f.native, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.run().completed;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /outside this checkout/);
  assert.equal(await readFile(join(external, f.configuration.library), 'utf8'), original);
});

test('refuse a linked cache outside the checkout before writing external content', async (t) => {
  const f = await fixture(t);
  const external = join(f.directory, 'external-cache');
  await mkdir(external);
  await rm(join(f.root, '.cache'), { recursive: true });
  await symlink(
    external,
    join(f.root, '.cache'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = await f.run().completed;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /outside this checkout/);
  assert.deepEqual(await readdir(external), []);
  assert.equal(await readFile(f.library, 'utf8'), original);
});

test('refuse a damaged cache and preserve the installed library', async (t) => {
  const f = await fixture(t);
  await f.seedCache();
  await writeFile(join(f.cache, f.configuration.library), 'damaged');
  const result = await f.run().completed;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cache is damaged/);
  assert.equal(await readFile(f.library, 'utf8'), original);
  assert.equal((await readdir(f.cache)).includes('building'), false);
});

test('reject an unsupported installed version before creating the build lock', async (t) => {
  const f = await fixture(t);
  const path = join(f.sdk, 'package.json');
  const metadata = JSON.parse(await readFile(path));
  await writeFile(path, JSON.stringify({ ...metadata, version: '0.34.1' }));
  const result = await f.run().completed;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /patches require 0\.34\.0/);
  assert.equal((await readdir(f.cache)).includes('building'), false);
  assert.equal(await readFile(f.library, 'utf8'), original);
});

test('reject a dependency version replacement during compilation', async (t) => {
  const f = await fixture(t);
  const result = await f.run('replace-version').completed;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /packages changed during the build/);
  assert.equal(JSON.parse(await readFile(join(f.native, 'package.json'))).version, '0.34.1');
  assert.equal(await readFile(f.library, 'utf8'), original);
  assert.equal((await readdir(f.cache)).includes('building'), false);
});

test('preserve the installed library and release the lock when compilation fails', async (t) => {
  const f = await fixture(t);
  const result = await f.run('fail').completed;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cargo failed \(42\)/);
  assert.equal(await readFile(f.library, 'utf8'), original);
  assert.equal((await readdir(f.cache)).includes('receipt.json'), false);
  assert.equal((await readdir(f.cache)).includes('building'), false);
});

test('refuse active and interrupted locks until both processes exit and the owner removes the lock', {
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t);
  const running = f.run('wait');
  let compilerPid;
  t.after(() => {
    const builderPid =
      running.child.exitCode === null && running.child.signalCode === null
        ? running.child.pid
        : undefined;
    for (const pid of [compilerPid, builderPid]) {
      if (pid)
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
    }
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    running.child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/COMPILER_READY (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    running.child.once('error', reject);
    running.child.once('exit', (code) =>
      reject(new Error(`Builder exited before compiler barrier: ${code}`)),
    );
  });
  compilerPid = await ready;
  const lock = join(f.cache, 'building');
  assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'))).pid, running.child.pid);
  const busy = await f.run('', ['--rebuild']).completed;
  assert.notEqual(busy.code, 0);
  assert.match(busy.stderr, /lock exists/);
  assert.match(busy.stderr, /Node and Cargo processes have exited/);
  const exited = once(running.child, 'exit');
  running.child.kill('SIGKILL');
  await exited;
  process.kill(compilerPid, 'SIGKILL');
  await running.completed;
  compilerPid = undefined;
  const interrupted = await f.run('', ['--rebuild']).completed;
  assert.notEqual(interrupted.code, 0);
  assert.match(interrupted.stderr, /lock exists/);
  await rm(lock, { recursive: true });
  const recovered = await f.run().completed;
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(await readFile(f.library, 'utf8'), candidate);
});
