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

const { app, powerMonitor } = require('electron');

app.whenReady().then(async () => {
  try {
    if (process.argv.includes('--foreground') && !process.argv.includes('--maka')) {
      throw new Error('--foreground requires --maka and targets only the owned AppKit fixture');
    }
    if (process.argv.includes('--double-click') && !process.argv.includes('--maka')) {
      throw new Error('--double-click requires --maka and targets only the owned AppKit fixture');
    }
    if (process.argv.includes('--host-admission')) {
      const { hostAdmissionSmoke } = await import('./results/host-admission-smoke.mjs');
      await hostAdmissionSmoke({
        resultsDirectory: require('node:path').join(__dirname, 'results'),
        screenLocked: () => powerMonitor.getSystemIdleState(1) === 'locked',
      });
    } else if (process.argv.includes('--maka')) {
      const { makaSmoke } = await import('./maka-smoke.mjs');
      await makaSmoke({
        foreground: process.argv.includes('--foreground'),
        doubleClick: process.argv.includes('--double-click'),
        screenLocked: () => powerMonitor.getSystemIdleState(1) === 'locked',
      });
    } else if (process.argv.includes('--fixture')) {
      const { fixtureSmoke } = await import('./fixture-smoke.mjs');
      await fixtureSmoke();
    } else {
      const { smoke } = await import('./smoke.mjs');
      await smoke();
    }
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
