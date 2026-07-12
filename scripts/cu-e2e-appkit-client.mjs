import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

export const defaultCuAppKitAppPath = join(
  repoRoot,
  '.agents-workspace-data',
  'cu-appkit-fixture',
  'CUAppKitFixture.app',
);

export function createCuAppKitSocketPath() {
  const suffix = Math.random().toString(16).slice(2, 10);
  return `/tmp/mcu-${process.pid}-${suffix}.sock`;
}

function appExecutable(appPath) {
  return join(appPath, 'Contents', 'MacOS', 'CUAppKitFixture');
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fixture did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.on('exit', onExit);
  });
}

async function waitForReady(socketPath, child, stderrChunks, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `fixture exited before socket became ready (${child.signalCode ?? `code ${child.exitCode}`}): `
          + Buffer.concat(stderrChunks).toString('utf8').trim(),
      );
    }
    try {
      await requestOverSocket(socketPath, 0, 'snapshot', {}, 250);
      return;
    } catch (error) {
      if (![
        'ENOENT',
        'ECONNREFUSED',
        'ECONNRESET',
        'EPIPE',
        'ETIMEDOUT',
      ].includes(error.code)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture socket was not ready within ${timeoutMs}ms: ${socketPath}`);
}

function requestOverSocket(socketPath, id, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error(`fixture request timed out after ${timeoutMs}ms: ${method}`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id) {
          finish(new Error(`fixture response id mismatch: expected ${id}, got ${response.id}`));
        } else if (!response.ok) {
          finish(new Error(response.error || `fixture ${method} request failed`));
        } else {
          finish(undefined, response.result);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled) finish(new Error(`fixture closed before responding to ${method}`));
    });
  });
}

export class CuAppKitFixtureClient {
  #nextRequestId = 1;

  constructor({ socketPath, child, stderrChunks = [], timeoutMs = 5_000 }) {
    this.socketPath = socketPath;
    this.child = child;
    this.stderrChunks = stderrChunks;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    const id = this.#nextRequestId++;
    return requestOverSocket(this.socketPath, id, method, params, this.timeoutMs);
  }

  show() {
    return this.request('show');
  }

  hide() {
    return this.request('hide');
  }

  reset() {
    return this.request('reset');
  }

  snapshot() {
    return this.request('snapshot');
  }

  setFrame(frame) {
    return this.request('setFrame', frame);
  }

  async shutdown() {
    const result = await this.request('shutdown');
    if (this.child) {
      await waitForExit(this.child, this.timeoutMs);
    }
    return result;
  }

  async terminate() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    try {
      await waitForExit(this.child, 2_000);
    } catch {
      this.child.kill('SIGKILL');
      await waitForExit(this.child, 2_000);
    }
  }
}

export async function launchCuAppKitFixture({
  appPath = defaultCuAppKitAppPath,
  socketPath = createCuAppKitSocketPath(),
  timeoutMs = 10_000,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('CUAppKitFixture can only run on macOS');
  }
  const stderrChunks = [];
  const child = spawn(appExecutable(appPath), ['--socket', socketPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MAKA_CU_APPKIT_SOCKET: socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  let onSpawnError;
  const startupError = new Promise((_, reject) => {
    onSpawnError = reject;
    child.once('error', onSpawnError);
  });
  try {
    await Promise.race([
      waitForReady(socketPath, child, stderrChunks, timeoutMs),
      startupError,
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child, 2_000).catch(() => child.kill('SIGKILL'));
    }
    throw error;
  } finally {
    child.off('error', onSpawnError);
  }
  return new CuAppKitFixtureClient({
    socketPath,
    child,
    stderrChunks,
    timeoutMs,
  });
}

export function connectCuAppKitFixture({
  socketPath,
  timeoutMs = 5_000,
}) {
  if (!socketPath) throw new Error('socketPath is required');
  return new CuAppKitFixtureClient({ socketPath, timeoutMs });
}

async function smoke(appPath) {
  const client = await launchCuAppKitFixture({ appPath });
  try {
    const initial = await client.snapshot();
    assert.equal(initial.activationPolicy, 'accessory');
    assert.equal(initial.window.visible, false);

    const shown = await client.show();
    assert.equal(shown.window.visible, true);
    assert.equal(shown.window.active, false);
    assert.equal(shown.window.key, false);
    assert.equal(shown.window.main, false);
    assert.ok(shown.window.number > 0);
    assert.ok(shown.elements.button.quartzTopLeftRect.width > 0);

    const moved = await client.setFrame({
      x: shown.window.quartzTopLeftRect.x,
      y: shown.window.quartzTopLeftRect.y,
      width: 420,
      height: 280,
    });
    assert.ok(moved.revision > shown.revision);
    for (const name of [
      'button',
      'checkbox',
      'textField',
      'slider',
      'scrollView',
      'rightClickView',
      'dragArena',
      'dragView',
    ]) {
      const rect = moved.elements[name].quartzTopLeftRect;
      const frame = moved.window.quartzTopLeftRect;
      assert.ok(rect.width > 0 && rect.height > 0, `${name} must have a visible rect`);
      assert.ok(rect.x >= frame.x && rect.y >= frame.y, `${name} must start inside the window`);
      assert.ok(
        rect.x + rect.width <= frame.x + frame.width + 1,
        `${name} must fit the window width`,
      );
      assert.ok(
        rect.y + rect.height <= frame.y + frame.height + 1,
        `${name} must fit the window height`,
      );
    }

    const reset = await client.reset();
    assert.equal(reset.controls.buttonClicks, 0);
    assert.equal(reset.controls.checkboxChecked, false);
    assert.equal(reset.controls.checkboxChanges, 0);
    assert.equal(reset.controls.text, '');
    assert.equal(reset.controls.textChanges, 0);
    assert.equal(reset.controls.sliderValue, 25);
    assert.equal(reset.controls.sliderChanges, 0);
    assert.equal(reset.controls.scrollEvents, 0);
    assert.equal(reset.controls.rightClicks, 0);
    assert.equal(reset.controls.dragCompletions, 0);

    const hidden = await client.hide();
    assert.equal(hidden.window.visible, false);
    await client.shutdown();
    console.log(JSON.stringify({
      ok: true,
      pid: shown.pid,
      socketPath: client.socketPath,
      revision: hidden.revision,
      appPath,
    }));
  } catch (error) {
    await client.terminate();
    throw error;
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'smoke') {
    smoke(argumentValue('--app') ?? defaultCuAppKitAppPath).catch((error) => {
      console.error('CU AppKit fixture smoke failed:', error);
      process.exitCode = 1;
    });
  } else if (command === 'call') {
    const socketPath = argumentValue('--socket');
    const method = argumentValue('--method');
    const paramsRaw = argumentValue('--params') ?? '{}';
    if (!socketPath || !method) {
      console.error('usage: node scripts/cu-e2e-appkit-client.mjs call --socket PATH --method METHOD [--params JSON]');
      process.exitCode = 2;
    } else {
      connectCuAppKitFixture({ socketPath })
        .request(method, JSON.parse(paramsRaw))
        .then((result) => console.log(JSON.stringify(result)))
        .catch((error) => {
          console.error('CU AppKit fixture request failed:', error);
          process.exitCode = 1;
        });
    }
  } else {
    console.error('usage: node scripts/cu-e2e-appkit-client.mjs smoke [--app APP] | call --socket PATH --method METHOD [--params JSON]');
    process.exitCode = 2;
  }
}
