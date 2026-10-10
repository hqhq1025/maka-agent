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

import { cp, mkdir } from 'node:fs/promises';
import { createPackageWithOptions } from '@electron/asar';
import { build } from 'esbuild';
const stage = new URL('./results/asar-stage/', import.meta.url).pathname;
await mkdir(`${stage}/node_modules`, { recursive: true });
await build({
  entryPoints: [
    new URL('../../packages/computer-use/dist/cua-driver-backend.js', import.meta.url).pathname,
  ],
  outfile: `${stage}/backend.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
for (const scope of ['@trycua', '@ubjs']) {
  await cp(
    new URL(`../../node_modules/${scope}`, import.meta.url),
    `${stage}/node_modules/${scope}`,
    { recursive: true },
  );
}
await createPackageWithOptions(stage, new URL('./results/app.asar', import.meta.url).pathname, {
  unpackDir: '**/node_modules/{@trycua,@ubjs}/**',
});
