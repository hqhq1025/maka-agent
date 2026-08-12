import { mkdir } from 'node:fs/promises';
import { runHostedExecution } from '@maka/runtime-host/client';
import type { HostedExecutionStartInput } from '@maka/runtime-host/protocol';
import { captureMakaRuntimeArtifacts, writeMakaArtifactCollectionError } from './maka-artifacts.js';

const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
  rootPath: string;
  artifactRoot: string;
  baseUrl: string;
  execution: HostedExecutionStartInput;
};
const abort = new AbortController();
let artifactCapture = Promise.resolve();
const captureArtifacts = (reason: 'settled' | 'signal') => {
  artifactCapture = artifactCapture.then(async () => {
    try {
      await captureMakaRuntimeArtifacts({
        stateRoot: payload.rootPath,
        destinationRoot: payload.artifactRoot,
        reason,
      });
    } catch (error) {
      await writeMakaArtifactCollectionError(payload.artifactRoot, error).catch(() => undefined);
    }
  });
  return artifactCapture;
};
const stop = () => {
  abort.abort();
  void captureArtifacts('signal');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await mkdir(payload.rootPath, { recursive: true });
let result: Awaited<ReturnType<typeof runHostedExecution>>;
try {
  result = await runHostedExecution({
    rootPath: payload.rootPath,
    baseUrl: payload.baseUrl,
    execution: payload.execution,
    signal: abort.signal,
  });
} finally {
  await captureArtifacts(abort.signal.aborted ? 'signal' : 'settled');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
process.stdout.write(JSON.stringify(result));
if (result.kind === 'indeterminate') process.exitCode = 1;
