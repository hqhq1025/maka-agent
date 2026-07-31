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
import type { MakaCuBackendOptions, MakaCuServiceSnapshot } from '@maka/computer-use';
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
  onTrace?: MakaCuBackendOptions['onTrace'];
  debug?: Parameters<typeof selectComputerUseBackend>[0] extends infer D
    ? D extends { debug?: infer F }
      ? F
      : never
    : never;
  overlay?: CuOverlayHook;
  /** Reads the development executor switch. Injected so tests need no env. */
  env?: NodeJS.ProcessEnv;
}): ComputerUseHostState {
  // Development override for an executor built somewhere else — a working tree,
  // a bisect, a colleague's build. Both variables are required: the path alone
  // would mean spawning a binary nobody verified, and "never spawn what you
  // cannot verify" has to hold on the development path too or it is not a rule.
  //
  //   MAKA_CU_EXECUTOR_PATH=/abs/path/to/OpenComputerUse
  //   MAKA_CU_EXECUTOR_SHA256=$(shasum -a 256 <path> | cut -d' ' -f1)
  const env = input.env ?? process.env;
  if (env.MAKA_CU_EXECUTOR_PATH || env.MAKA_CU_EXECUTOR_SHA256) {
    const executorPath = env.MAKA_CU_EXECUTOR_PATH;
    const executorSha256 = env.MAKA_CU_EXECUTOR_SHA256;
    if (!executorPath || !/^[a-f0-9]{64}$/.test(executorSha256 ?? '')) {
      // Refused rather than quietly falling back to the bundled artifact: an
      // operator who pointed at one build and silently got another would draw
      // conclusions from the wrong executor.
      return { selected: selectComputerUseBackend() };
    }
    return {
      selected: selectComputerUseBackend({
        binaryPath: executorPath,
        expectedBinarySha256: executorSha256,
        ...(input.compressFrame ? { compressFrame: input.compressFrame } : {}),
        ...(input.physicalInputRecentlyActive
          ? { physicalInputRecentlyActive: input.physicalInputRecentlyActive }
          : {}),
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
        ...(input.overlay ? { overlay: input.overlay } : {}),
        allowCompatibilityInputDispatch: true,
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
    ? join(input.resourcesPath, 'bin', 'maka-cu')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'resources',
        'bin',
        'maka-cu',
      ));
  try {
    const manifest = JSON.parse(readRegularFile(manifestPath).toString('utf8')) as {
      makaCu?: {
        binarySha256?: string;
        distributionReady?: boolean;
      };
    };
    const expectedBinarySha256 = manifest.makaCu?.binarySha256;
    if (input.isPackaged && manifest.makaCu?.distributionReady !== true) {
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
        ...(input.compressFrame ? { compressFrame: input.compressFrame } : {}),
        ...(input.physicalInputRecentlyActive
          ? { physicalInputRecentlyActive: input.physicalInputRecentlyActive }
          : {}),
        ...(input.screenLocked ? { screenLocked: input.screenLocked } : {}),
        ...(input.onTrace ? { onTrace: input.onTrace } : {}),
        ...(input.debug ? { debug: input.debug } : {}),
        ...(input.overlay ? { overlay: input.overlay } : {}),
        // Typing and scrolling are the product, not an extra. maka.cu posts
        // them pid-bound, so enabling them does not hand anything a global
        // event tap; the physical-input guard above still refuses each of
        // those paths while the user is actually at the keyboard.
        allowCompatibilityInputDispatch: true,
      }),
      binaryPath,
      expectedBinarySha256,
    };
  } catch {
    return { selected: selectComputerUseBackend() };
  }
}

/**
 * One executor, one state.
 *
 * cua-driver ran as a pair of roles — one process to act, one to capture — so
 * this had to reconcile two states into one word, and "healthy" meant both.
 * maka-cu supervises a single child, so the reported state is the state.
 */
export function computerUseServiceHealth(
  backendId: SelectedComputerUseBackend<CuBackendId>['backendId'],
  state: MakaCuServiceSnapshot | undefined,
): {
  state: 'not_available' | 'not_run' | 'healthy' | 'degraded';
  reason: string;
} {
  if (backendId === 'none' || !state) {
    return {
      state: 'not_available',
      reason: '未找到通过完整性检查且可分发的 maka-cu executor。',
    };
  }
  switch (state.state) {
    case 'disposed':
      return { state: 'not_available', reason: 'maka-cu executor 已停止。' };
    case 'unavailable':
      return { state: 'not_available', reason: 'maka-cu executor 启动失败或已退出。' };
    case 'starting':
    case 'backing_off':
      return { state: 'degraded', reason: 'maka-cu executor 正在启动或恢复。' };
    case 'ready':
      return { state: 'healthy', reason: 'maka-cu executor 已就绪。' };
    default:
      return { state: 'not_run', reason: 'maka-cu 已可用，将在首次调用时启动。' };
  }
}
