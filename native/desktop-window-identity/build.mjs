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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

/** Build the Desktop window identity and capture addon for the current OS. */
export async function buildDesktopWindowIdentity({ arch = process.arch } = {}) {
  if (!['darwin', 'win32'].includes(process.platform)) return undefined;
  if (!['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported Desktop window identity architecture');
  const require = createRequire(import.meta.url);
  const headers = join(dirname(require.resolve('node-api-headers/package.json')), 'include');
  const outputDirectory = join(root, 'build');
  const output = join(outputDirectory, 'maka_desktop_window_identity.node');
  await mkdir(outputDirectory, { recursive: true });
  if (process.platform === 'win32') {
    await buildWindows({ arch, headers, output, require });
    return output;
  }
  await run(
    'xcrun',
    [
      'clang++',
      '-std=c++20',
      '-fobjc-arc',
      '-O2',
      '-fvisibility=hidden',
      '-DNAPI_VERSION=8',
      '-DNODE_GYP_MODULE_NAME=maka_desktop_window_identity',
      '-arch',
      arch === 'x64' ? 'x86_64' : arch,
      '-mmacosx-version-min=12.0',
      '-dynamiclib',
      '-undefined',
      'dynamic_lookup',
      '-I',
      headers,
      '-framework',
      'ApplicationServices',
      '-framework',
      'CoreFoundation',
      '-framework',
      'Foundation',
      '-framework',
      'AppKit',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'CoreMedia',
      '-framework',
      'CoreVideo',
      '-framework',
      'Accelerate',
      `-ffile-prefix-map=${root}=native/desktop-window-identity`,
      join(root, 'window-identity.mm'),
      join(root, 'bgra-capture.mm'),
      '-o',
      output,
    ],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  await run('install_name_tool', ['-id', '@rpath/maka_desktop_window_identity.node', output]);
  await run('strip', ['-x', output]);
  return output;
}

async function buildWindows({ arch, headers, output, require }) {
  const desktop = JSON.parse(await readFile(join(root, '../../apps/desktop/package.json'), 'utf8'));
  const version = desktop.devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Desktop Electron version must be pinned');
  const cache = join(root, 'build', `electron-${version}-${arch}`);
  await mkdir(cache, { recursive: true });
  const base = `https://electronjs.org/headers/v${version}/`;
  const fetchBytes = async (path) => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Electron headers download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sumsPath = join(cache, 'SHASUMS256.txt');
  const library = join(cache, 'node.lib');
  const sums = await readFile(sumsPath).catch(async () => {
    const bytes = await fetchBytes('SHASUMS256.txt');
    await writeFile(sumsPath, bytes);
    return bytes;
  });
  const expected = sums
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((row) => row[1] === `win-${arch}/node.lib`)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Electron node.lib checksum is missing');
  const bytes = await readFile(library).catch(() => fetchBytes(`win-${arch}/node.lib`));
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Electron node.lib checksum mismatch');
  await writeFile(library, bytes);
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  const result = await run(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ]);
  const install = result.stdout.trim();
  if (!install) throw new Error('Visual Studio C++ Build Tools are required');
  const hook = join(
    dirname(require.resolve('node-gyp/package.json')),
    'src',
    'win_delay_load_hook.cc',
  );
  const quote = (value) => {
    if (/["\r\n%]/.test(value)) throw new Error('Unsupported character in native build path');
    return `"${value}"`;
  };
  const command = [
    '@echo off',
    `call ${quote(join(install, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat'))} ${arch === 'arm64' ? 'x64_arm64' : 'x64'}`,
    'if errorlevel 1 exit /b %errorlevel%',
    `cl /nologo /std:c++20 /EHsc /O2 /LD /DNAPI_VERSION=8 /DNODE_GYP_MODULE_NAME=maka_desktop_window_identity /DHOST_BINARY=\\"node.exe\\" /I ${quote(headers)} ${quote(join(root, 'src', 'windows.cc'))} ${quote(hook)} /link ${quote(library)} user32.lib gdi32.lib ole32.lib windowscodecs.lib delayimp.lib /DELAYLOAD:node.exe /OUT:${quote(output)}`,
    'exit /b %errorlevel%',
  ].join('\r\n');
  const script = join(root, 'build', 'build-windows.cmd');
  await writeFile(script, command);
  await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${script}"`], {
    cwd: dirname(output),
    windowsVerbatimArguments: true,
    maxBuffer: 1024 * 1024,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = await buildDesktopWindowIdentity({ arch: process.argv[2] ?? process.arch });
  if (output) process.stdout.write(`${output}\n`);
}
