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
import { test } from 'node:test';
import { getPermissionCenterCopy } from '../../renderer/locales/permission-center-copy.js';
import { getCapabilityReasonCopy } from '../../renderer/locales/capability-reason-copy.js';

test('presents a granted OS permission as a verified success', () => {
  assert.equal(getPermissionCenterCopy('zh-CN').osStates.granted.tone, 'success');
  assert.equal(getPermissionCenterCopy('en').osStates.granted.tone, 'success');
});

test('renders capability reason codes per locale', () => {
  const zh = getCapabilityReasonCopy('zh-CN');
  const en = getCapabilityReasonCopy('en');
  assert.equal(zh.platform_credentials_missing, '未配置平台凭据');
  assert.equal(en.platform_credentials_missing, 'Platform credentials are not configured');
  assert.equal(zh.cu_executor_recovering, '正在加载 Cua Driver。');
  assert.equal(en.cu_executor_recovering, 'Loading Cua Driver.');
});

test('composes the computer-use backend status from snapshot facts per locale', () => {
  const zh = getPermissionCenterCopy('zh-CN');
  const en = getPermissionCenterCopy('en');
  assert.equal(
    zh.cuBackendStatus(['辅助功能', '屏幕录制'], 'healthy'),
    '等待辅助功能、屏幕录制权限。Cua Driver 已就绪；操作前仍会检查目标应用和操作授权。',
  );
  assert.equal(
    zh.cuBackendStatus([], 'not_run'),
    'Cua Driver 将在首次电脑操作时加载，并检查桌面环境与权限。',
  );
  assert.equal(
    en.cuBackendStatus(['Accessibility'], 'degraded'),
    'Waiting for Accessibility permission. Cua Driver is not ready: it is loading, or the desktop environment or permissions need attention.',
  );
});
