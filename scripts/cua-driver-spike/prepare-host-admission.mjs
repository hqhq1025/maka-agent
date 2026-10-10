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

import { build } from 'esbuild';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = fileURLToPath(new URL('./results/', import.meta.url));
await mkdir(output, { recursive: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL('./host-admission-smoke.mjs', import.meta.url))],
  outfile: join(output, 'host-admission-smoke.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  metafile: true,
  plugins: [
    {
      name: 'current-maka-sources',
      setup(plugin) {
        plugin.onResolve({ filter: /^@maka\// }, async ({ path }) => {
          const [, packageName, suffix = ''] = /^@maka\/([^/]+)(.*)$/.exec(path);
          const directory = join(root, 'packages', packageName);
          const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          const exported = manifest.exports[suffix ? `.${suffix}` : '.'];
          if (typeof exported !== 'string' || !exported.startsWith('./dist/')) {
            throw new Error(`No exact source export for ${path}`);
          }
          const source = join(
            directory,
            exported.replace('./dist/', './src/').replace(/\.js$/, '.ts'),
          );
          await access(source);
          return { path: source };
        });
      },
    },
  ],
});
await writeFile(
  join(output, 'host-admission-build.json'),
  JSON.stringify(result.metafile, null, 2),
);
console.log(
  `Bundled ${Object.keys(result.metafile.inputs).length} current source modules; shared dist was not modified.`,
);
