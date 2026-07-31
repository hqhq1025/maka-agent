import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import {
  createComputerUseHost,
  computerUseServiceHealth,
} from '../computer-use-host.js';

describe('Computer Use host health', () => {
  const executor = (
    state: 'idle' | 'starting' | 'ready' | 'backing_off' | 'unavailable' | 'disposed',
  ) => ({ state, generation: 1, restartAttempts: 0 });

  it('does not report a binary-only backend as healthy before first use', () => {
    assert.deepEqual(computerUseServiceHealth('maka-cu', executor('idle')), {
      state: 'not_run',
      reason: 'maka-cu 已可用，将在首次调用时启动。',
    });
  });

  it('reports ready, recovery, and unavailable states', () => {
    assert.equal(computerUseServiceHealth('maka-cu', executor('ready')).state, 'healthy');
    assert.equal(
      computerUseServiceHealth('maka-cu', executor('starting')).reason,
      'maka-cu executor 正在启动或恢复。',
    );
    assert.equal(
      computerUseServiceHealth('maka-cu', executor('backing_off')).reason,
      'maka-cu executor 正在启动或恢复。',
    );
    assert.deepEqual(computerUseServiceHealth('maka-cu', executor('unavailable')), {
      state: 'not_available',
      reason: 'maka-cu executor 启动失败或已退出。',
    });
    assert.deepEqual(computerUseServiceHealth('maka-cu', executor('disposed')), {
      state: 'not_available',
      reason: 'maka-cu executor 已停止。',
    });
  });

  it('reports a missing backend as unavailable', () => {
    assert.equal(computerUseServiceHealth('none', undefined).state, 'not_available');
  });

  it('constructs a backend only when the local artifact matches the manifest hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-cu-host-'));
    try {
      const binaryPath = join(directory, 'maka-cu');
      const manifestPath = join(directory, 'bundled-tools.json');
      const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
      await writeFile(binaryPath, bytes);
      await chmod(binaryPath, 0o755);
      const hash = createHash('sha256').update(bytes).digest('hex');
      await writeFile(manifestPath, JSON.stringify({
        makaCu: { binarySha256: hash, distributionReady: false },
      }));

      const validForDevelopment = createComputerUseHost({
        isPackaged: false,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
      });
      assert.equal(validForDevelopment.selected.backendId, process.platform === 'darwin'
        ? 'maka-cu'
        : 'none');

      const blockedForDistribution = createComputerUseHost({
        isPackaged: true,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
      });
      assert.equal(blockedForDistribution.selected.backendId, 'none');

      await writeFile(manifestPath, JSON.stringify({
        makaCu: { binarySha256: hash, distributionReady: true },
      }));
      const validForDistribution = createComputerUseHost({
        isPackaged: true,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
      });
      assert.equal(validForDistribution.selected.backendId, process.platform === 'darwin'
        ? 'maka-cu'
        : 'none');

      await writeFile(manifestPath, JSON.stringify({
        makaCu: {
          binarySha256: '0'.repeat(64),
          distributionReady: true,
        },
      }));
      const invalid = createComputerUseHost({
        isPackaged: false,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
      });
      assert.equal(invalid.selected.backendId, 'none');

      const linkedBinaryPath = join(directory, 'linked-maka-cu');
      await symlink(binaryPath, linkedBinaryPath);
      const linked = createComputerUseHost({
        isPackaged: false,
        resourcesPath: directory,
        manifestPath,
        binaryPath: linkedBinaryPath,
      });
      assert.equal(linked.selected.backendId, 'none');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts a host-owned physical-input guard', async () => {
    const source = await readFile(
      new URL('../../../src/main/computer-use-host.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /physicalInputRecentlyActive/);
    assert.match(source, /selectComputerUseBackend/);
  });

  it('wires a one-second physical-input quiet window', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readMainProcessCombinedSource());
    assert.match(source, /physicalInputRecentlyActive/);
    assert.match(source, /powerMonitor\.getSystemIdleTime\(\) < 1/);
  });
});
