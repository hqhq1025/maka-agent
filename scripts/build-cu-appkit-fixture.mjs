import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const packagePath = join(here, 'fixtures', 'cu-appkit-fixture');
const outputRoot = join(repoRoot, '.agents-workspace-data', 'cu-appkit-fixture');
const scratchPath = join(outputRoot, 'swift-build');
const appPath = join(outputRoot, 'CUAppKitFixture.app');
const executableName = 'CUAppKitFixture';

async function run(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr) process.stderr.write(stderr);
  return stdout.trim();
}

export async function buildCuAppKitFixture() {
  if (process.platform !== 'darwin') {
    throw new Error('CUAppKitFixture can only be built on macOS');
  }

  await mkdir(outputRoot, { recursive: true });
  await run('swift', [
    'build',
    '--package-path',
    packagePath,
    '--configuration',
    'release',
    '--scratch-path',
    scratchPath,
    '--product',
    executableName,
  ]);
  const binaryRoot = await run('swift', [
    'build',
    '--package-path',
    packagePath,
    '--configuration',
    'release',
    '--scratch-path',
    scratchPath,
    '--show-bin-path',
  ]);

  await rm(appPath, { recursive: true, force: true });
  const contentsPath = join(appPath, 'Contents');
  const macOSPath = join(contentsPath, 'MacOS');
  await mkdir(macOSPath, { recursive: true });
  await copyFile(join(binaryRoot, executableName), join(macOSPath, executableName));
  await chmod(join(macOSPath, executableName), 0o755);
  await copyFile(join(packagePath, 'Info.plist'), join(contentsPath, 'Info.plist'));
  await writeFile(join(contentsPath, 'PkgInfo'), 'APPL????', 'ascii');

  await run('/usr/bin/plutil', ['-lint', join(contentsPath, 'Info.plist')]);
  await run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--timestamp=none',
    appPath,
  ]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);

  return appPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCuAppKitFixture()
    .then((builtAppPath) => {
      console.log(builtAppPath);
    })
    .catch((error) => {
      console.error('CU AppKit fixture build failed:', error);
      process.exitCode = 1;
    });
}
