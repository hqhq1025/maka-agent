#!/usr/bin/env node
// Build the maka-cu executor from source and pin the result.
//
// cua-driver arrived as a signed upstream release, so preparing it meant
// downloading a tarball and checking it against a digest someone else produced.
// maka-cu is ours: there is no third party to download from, and the artifact
// that matters is the one this machine just built. So this script builds it,
// records what it built, and writes both into apps/desktop/bundled-tools.json —
// the same manifest the host reads, so the running app can only ever spawn a
// binary whose bytes match the ones recorded here.
//
// Nothing about this is a substitute for signing. `distributionReady` stays
// false until a notarized artifact exists, and the host refuses to use an
// unready entry in a packaged build — a development build is the only place
// this binary runs.
//
//   node scripts/prepare-maka-cu.mjs
//   MAKA_CU_SOURCE=/path/to/maka-cu node scripts/prepare-maka-cu.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const destination = join(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'maka-cu');

/** Universal and single-architecture Mach-O, both byte orders. */
const MACH_O_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function fail(message) {
  process.stderr.write(`prepare-maka-cu: ${message}\n`);
  process.exit(1);
}

function sourcePath() {
  const explicit = process.env.MAKA_CU_SOURCE;
  if (explicit) return resolve(explicit);
  // A sibling checkout is the layout this repo is developed in; naming it here
  // beats every contributor discovering the variable.
  return resolve(repoRoot, '..', 'maka-cu');
}

function assertMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4) fail(`${path} is too short to be an executable.`);
    if (!MACH_O_MAGICS.has(head.readUInt32BE(0)) && !MACH_O_MAGICS.has(head.readUInt32LE(0))) {
      fail(`${path} is not a Mach-O executable.`);
    }
  } finally {
    closeSync(fd);
  }
}

function git(source, args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
}

const source = sourcePath();
if (!existsSync(join(source, 'Package.swift'))) {
  fail(`no Swift package at ${source}. Set MAKA_CU_SOURCE to the maka-cu checkout.`);
}

// A dirty tree would pin bytes to a commit that does not describe them.
const status = git(source, ['status', '--porcelain']);
if (status && process.env.MAKA_CU_ALLOW_DIRTY !== '1') {
  fail(
    `${source} has uncommitted changes, so the recorded commit would not describe the ` +
      'binary. Commit them, or set MAKA_CU_ALLOW_DIRTY=1 for a throwaway build.',
  );
}

process.stderr.write(`prepare-maka-cu: building ${source}\n`);
execFileSync('swift', ['build', '-c', 'release', '--package-path', source], { stdio: 'inherit' });

const built = execFileSync(
  'swift',
  ['build', '-c', 'release', '--package-path', source, '--show-bin-path'],
  { encoding: 'utf8' },
).trim();
const binary = join(built, 'OpenComputerUse');
if (!existsSync(binary)) fail(`swift build produced no ${binary}.`);
assertMachO(binary);

const bytes = readFileSync(binary);
const binarySha256 = createHash('sha256').update(bytes).digest('hex');

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(binary, destination);
chmodSync(destination, 0o755);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.makaCu = {
  repo: 'hqhq1025/maka-cu',
  branch: git(source, ['rev-parse', '--abbrev-ref', 'HEAD']),
  commit: git(source, ['rev-parse', 'HEAD']),
  expectedProtocolVersion: 'maka.cu/2',
  binaryName: 'maka-cu',
  binarySizeBytes: statSync(binary).size,
  binarySha256,
  buildProvenance: 'local-source-build',
  signature: 'none',
  notarization: 'missing',
  // The host refuses an unready entry in a packaged build. Flipping this needs
  // a signed, notarized artifact, not an edit here.
  distributionReady: false,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stderr.write(
  `prepare-maka-cu: ${destination}\n` +
    `prepare-maka-cu: sha256 ${binarySha256}\n` +
    `prepare-maka-cu: commit ${manifest.makaCu.commit} on ${manifest.makaCu.branch}\n`,
);
