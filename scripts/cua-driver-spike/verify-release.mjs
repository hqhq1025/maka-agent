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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Digests published with the exact official GitHub release, not a registry tag.
const assets = {
  'trycua-cua-driver-0.34.0.tgz':
    '4ad0e65e26e6ab273d579b998af2526165dd611b6d31206c2cf4385f54af7b18',
  'trycua-cua-driver-darwin-arm64-0.34.0.tgz':
    'e2ae1c7e8b45b7ca66ee352035cf7aedc31e20a23c19d653d6fbec27407a9da3',
};
for (const [name, expected] of Object.entries(assets)) {
  const response = await fetch(
    `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.0/${name}`,
    { signal: AbortSignal.timeout(60000) },
  );
  assert.ok(response.ok, `${name}: HTTP ${response.status}`);
  const sha256 = createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex');
  assert.equal(sha256, expected, `${name}: release digest mismatch`);
  console.log(JSON.stringify({ asset: name, sha256, verified: true }));
}
