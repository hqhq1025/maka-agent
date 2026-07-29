import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuaDriverRoleSnapshot } from '@maka/computer-use';
import type { CuaDriverBackendOptions } from '@maka/computer-use';
import {
  selectComputerUseBackend,
  type CuBackendId,
  type SelectedComputerUseBackend,
} from '@maka/computer-use';
import type { CuOverlayHook } from '@maka/runtime';

export interface ComputerUseHostState {
  /**
   * Widened to both executors. The selector defaults its generic to
   * `cua-driver` so a caller that never asks for maka-cu cannot be handed it;
   * the host is the one place that does ask, so it is the one place the type
   * opens up.
   */
  selected: SelectedComputerUseBackend<CuBackendId>;
  binaryPath?: string;
  expectedBinarySha256?: string;
}

function readRegularFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('expected a regular file');
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createComputerUseHost(input: {
  isPackaged: boolean;
  resourcesPath: string;
  manifestPath?: string;
  binaryPath?: string;
  compressFrame?: (
    base64: string,
    mimeType: string,
  ) => { base64: string; mimeType: 'image/png' | 'image/jpeg' };
  physicalInputRecentlyActive?: () => boolean | Promise<boolean>;
  screenLocked?: () => boolean | Promise<boolean>;
  onTrace?: CuaDriverBackendOptions['onTrace'];
  debug?: Parameters<typeof selectComputerUseBackend>[0] extends infer D
    ? D extends { debug?: infer F }
      ? F
      : never
    : never;
  overlay?: CuOverlayHook;
  /** Reads the development executor switch. Injected so tests need no env. */
  env?: NodeJS.ProcessEnv;
}): ComputerUseHostState {
  // Development switch for the maka-cu executor, which has no bundled,
  // signed artifact yet and therefore cannot be a setting. Both variables are
  // required: the path alone would mean spawning a binary nobody verified, and
  // "never spawn what you cannot verify" has to hold on the development path
  // too or it is not a rule.
  //
  //   MAKA_CU_EXECUTOR=maka-cu
  //   MAKA_CU_EXECUTOR_PATH=/abs/path/to/OpenComputerUse
  //   MAKA_CU_EXECUTOR_SHA256=$(shasum -a 256 <path> | cut -d' ' -f1)
  const env = input.env ?? process.env;
  if (env.MAKA_CU_EXECUTOR === 'maka-cu') {
    const executorPath = env.MAKA_CU_EXECUTOR_PATH;
    const executorSha256 = env.MAKA_CU_EXECUTOR_SHA256;
    if (!executorPath || !/^[a-f0-9]{64}$/.test(executorSha256 ?? '')) {
      // Refused rather than quietly falling back: an operator who asked for
      // maka-cu and silently got cua-driver would draw conclusions from the
      // wrong executor.
      return { selected: selectComputerUseBackend() };
    }
    return {
      selected: selectComputerUseBackend({
        backendId: 'maka-cu',
        binaryPath: executorPath,
        expectedBinarySha256: executorSha256,
        ...(input.compressFrame ? { compressFrame: input.compressFrame } : {}),
        ...(input.physicalInputRecentlyActive
          ? { physicalInputRecentlyActive: input.physicalInputRecentlyActive }
          : {}),
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
        ...(input.overlay ? { overlay: input.overlay } : {}),
      }),
      binaryPath: executorPath,
      expectedBinarySha256: executorSha256,
    };
  }
  const manifestPath = input.manifestPath ?? (input.isPackaged
    ? join(input.resourcesPath, 'bundled-tools.json')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'bundled-tools.json',
      ));
  const binaryPath = input.binaryPath ?? (input.isPackaged
    ? join(input.resourcesPath, 'bin', 'cua-driver')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'resources',
        'bin',
        'cua-driver',
      ));
  try {
    const manifest = JSON.parse(readRegularFile(manifestPath).toString('utf8')) as {
      cuaDriver?: {
        binarySha256?: string;
        distributionReady?: boolean;
        expectedVersion?: string;
        expectedProtocolVersion?: string;
      };
    };
    const expectedBinarySha256 = manifest.cuaDriver?.binarySha256;
    const expectedServerVersion = manifest.cuaDriver?.expectedVersion;
    const expectedProtocolVersion =
      manifest.cuaDriver?.expectedProtocolVersion;
    if (input.isPackaged && manifest.cuaDriver?.distributionReady !== true) {
      return { selected: selectComputerUseBackend() };
    }
    if (!expectedBinarySha256 || !/^[a-f0-9]{64}$/.test(expectedBinarySha256)) {
      return { selected: selectComputerUseBackend() };
    }
    accessSync(binaryPath, constants.R_OK | constants.X_OK);
    const actual = createHash('sha256')
      .update(readRegularFile(binaryPath))
      .digest('hex');
    if (actual !== expectedBinarySha256) {
      return { selected: selectComputerUseBackend() };
    }
    return {
      selected: selectComputerUseBackend({
        binaryPath,
        expectedBinarySha256,
        expectedServerName: 'cua-driver',
        ...(expectedServerVersion ? { expectedServerVersion } : {}),
        ...(expectedProtocolVersion ? { expectedProtocolVersion } : {}),
        ...(input.compressFrame ? { compressFrame: input.compressFrame } : {}),
        ...(input.physicalInputRecentlyActive
          ? { physicalInputRecentlyActive: input.physicalInputRecentlyActive }
          : {}),
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
        ...(input.onTrace ? { onTrace: input.onTrace } : {}),
        ...(input.debug ? { debug: input.debug } : {}),
        ...(input.overlay ? { overlay: input.overlay } : {}),
      }),
      binaryPath,
      expectedBinarySha256,
    };
  } catch {
    return { selected: selectComputerUseBackend() };
  }
}

export function computerUseServiceHealth(
  backendId: SelectedComputerUseBackend<CuBackendId>['backendId'],
  state: {
    action: CuaDriverRoleSnapshot;
    capture: CuaDriverRoleSnapshot;
  } | undefined,
): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded';
  reason: string;
} {
  if (backendId === 'none' || !state) {
    return {
      state: 'not_available',
      reason: '未找到通过完整性检查且可分发的 cua-driver artifact。',
    };
  }
  const roles = [state.action, state.capture];
  if (roles.some((role) =>
    role.state === 'unavailable' || role.state === 'disposed')) {
    return {
      state: 'not_available',
      reason: roles.some((role) => role.state === 'disposed')
        ? 'cua-driver service 已停止。'
        : 'cua-driver service 启动失败或已退出。',
    };
  }
  if (roles.some((role) =>
    role.state === 'starting' || role.state === 'backing_off')) {
    return {
      state: 'degraded',
      reason: 'cua-driver service 正在启动或恢复。',
    };
  }
  if (roles.every((role) => role.state === 'ready')) {
    return {
      state: 'healthy',
      reason: 'cua-driver 操作与截图服务已就绪。',
    };
  }
  if (roles.some((role) => role.state === 'ready')) {
    return {
      state: 'not_run',
      reason: 'cua-driver 部分服务已启动，其余服务将在需要时启动。',
    };
  }
  return {
    state: 'not_run',
    reason: 'cua-driver 已可用，将在首次调用时启动。',
  };
}
