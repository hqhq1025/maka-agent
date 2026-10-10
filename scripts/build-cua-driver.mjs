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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function ownedPath(path) {
  const resolved = await realpath(path);
  const within = relative(await realpath(root), resolved);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error(
      `Cua Driver path resolved outside this checkout: ${path}. Run npm ci here first.`,
    );
  }
  return resolved;
}

async function installedPackage(name, from) {
  const search = createRequire(join(from, 'package.json')).resolve.paths(name) ?? [];
  for (const directory of search) {
    const path = join(directory, name, 'package.json');
    let metadata;
    try {
      metadata = await readJson(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const directoryPath = await ownedPath(dirname(path));
    if (metadata.name !== name) throw new Error(`Unexpected package at ${path}`);
    return { directory: directoryPath, metadata };
  }
  throw new Error(`${name} is missing. Run npm ci with optional dependencies enabled.`);
}

/** Restore the verified native patches after npm ci without changing SDK resolution. */
export async function buildCuaDriver({ rebuild = false } = {}) {
  const manifestDirectory = join(root, 'patches/cua-driver');
  const manifest = await readJson(join(manifestDirectory, 'manifest.json'));
  const platform = manifest.platforms[process.platform];
  if (!platform) return { status: 'official-native', platform: process.platform };
  if (!['x64', 'arm64'].includes(process.arch))
    throw new Error('Unsupported Cua Driver architecture');
  const sdk = await installedPackage('@trycua/cua-driver', join(root, 'packages/computer-use'));
  const nativeName = `@trycua/cua-driver-${platform.packageSuffix}-${process.arch}${process.platform === 'win32' ? '-msvc' : ''}`;
  const native = await installedPackage(nativeName, sdk.directory);
  const rustTarget = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc'}`;
  for (const pkg of [sdk, native]) {
    if (pkg.metadata.version !== manifest.version) {
      throw new Error(
        `Cua Driver patches require ${manifest.version}; found ${pkg.metadata.name}@${pkg.metadata.version}. Update and qualify the patch manifest before upgrading.`,
      );
    }
  }
  for (const patch of platform.patches) {
    if (sha256(await readFile(join(manifestDirectory, patch.file))) !== patch.sha256) {
      throw new Error(`Cua Driver patch checksum mismatch: ${patch.file}`);
    }
  }
  const identity = sha256(
    JSON.stringify({ manifest, platform: process.platform, arch: process.arch, rustTarget }),
  );
  const cache = join(root, '.cache/cua-driver', identity);
  for (const directory of [join(root, '.cache'), join(root, '.cache/cua-driver'), cache]) {
    await mkdir(directory, { recursive: true });
    await ownedPath(directory);
  }
  const lock = join(cache, 'building');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `Cua Driver build lock exists: ${lock}. Check owner.json and wait for the build. If interrupted, confirm its Node and Cargo processes have exited before removing this directory and retrying.`,
      );
    throw error;
  }
  const cachedLibrary = join(cache, platform.library);
  const receiptPath = join(cache, 'receipt.json');
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), root }, null, 2) +
        '\n',
    );
    if (rebuild) await rm(receiptPath, { force: true });
    let receipt;
    try {
      receipt = await readJson(receiptPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (receipt) {
      if (
        receipt.identity !== identity ||
        sha256(await readFile(cachedLibrary)) !== receipt.sha256
      ) {
        throw new Error(
          'Cua Driver build cache is damaged. Run npm run build:cua-driver -- --rebuild.',
        );
      }
    } else {
      const source = join(cache, 'source');
      const archive = join(cache, 'source.tar.gz');
      let bytes;
      try {
        bytes = await readFile(archive);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!bytes) {
        const url = `https://codeload.github.com/trycua/cua/tar.gz/${manifest.sourceCommit}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Cua Driver source download failed: ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (sha256(bytes) !== manifest.sourceSha256)
        throw new Error(`Cua Driver source checksum mismatch: ${archive}`);
      await writeFile(archive, bytes);
      await rm(source, { recursive: true, force: true });
      await mkdir(source);
      await run('tar', ['-xzf', archive, '--strip-components=1', '-C', source], cache);
      // This source tree is nested in Maka's checkout. A separate Git repository
      // makes git apply interpret every patch relative to the upstream tree.
      await run('git', ['init', '--quiet'], source);
      for (const patch of platform.patches) {
        const args = ['apply', '--whitespace=nowarn'];
        if (patch.directory !== '.') args.push(`--directory=${patch.directory}`);
        args.push(join(manifestDirectory, patch.file));
        await run('git', [...args.slice(0, -1), '--check', args.at(-1)], source);
        await run('git', args, source);
      }
      const crate = join(source, 'libs/cua-driver/rust');
      const target = join(cache, 'target');
      await run(
        'cargo',
        [
          `+${manifest.rustToolchain}`,
          'build',
          '--locked',
          '--release',
          '--target',
          rustTarget,
          '-p',
          'cua-driver-sdk',
        ],
        crate,
        { ...process.env, CARGO_TARGET_DIR: target },
      );
      await copyFile(join(target, rustTarget, 'release', platform.library), cachedLibrary);
      receipt = {
        identity,
        version: manifest.version,
        sourceCommit: manifest.sourceCommit,
        rustTarget,
        sha256: sha256(await readFile(cachedLibrary)),
      };
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    }
    // npm ci/update may replace packages while Cargo is compiling. Re-resolve
    // both packages before installing a library built for the original version.
    const currentSdk = await installedPackage(
      '@trycua/cua-driver',
      join(root, 'packages/computer-use'),
    );
    const currentNative = await installedPackage(nativeName, currentSdk.directory);
    if (
      currentSdk.directory !== sdk.directory ||
      currentNative.directory !== native.directory ||
      currentSdk.metadata.version !== manifest.version ||
      currentNative.metadata.version !== manifest.version
    ) {
      throw new Error(
        'Cua Driver packages changed during the build. Finish npm ci/update and retry.',
      );
    }
    const destination = join(currentNative.directory, platform.library);
    const existing = await readFile(destination).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!existing || sha256(existing) !== receipt.sha256) {
      const temporary = `${destination}.maka-${process.pid}.tmp`;
      try {
        await copyFile(cachedLibrary, temporary);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return {
      status: 'patched-native',
      platform: process.platform,
      arch: process.arch,
      ...receipt,
      destination,
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--rebuild'))
    throw new Error('Usage: node scripts/build-cua-driver.mjs [--rebuild]');
  console.log(
    JSON.stringify(await buildCuaDriver({ rebuild: args.includes('--rebuild') }), null, 2),
  );
}
