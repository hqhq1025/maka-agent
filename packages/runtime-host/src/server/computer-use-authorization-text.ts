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

import {
  INTERACTION_AUTHORIZATION_TEXT_MAX_BYTES,
  type InteractionClientCapabilityRequest,
} from '@maka/core/interaction';

const ALLOW = new Set([
  '批准',
  '同意',
  '允许',
  '允許',
  '授权',
  '授權',
  '我批准',
  '我同意',
  '可以',
  '可以的',
  '好的',
  '好',
  '批准吧',
  '同意了',
  '可以，继续吧',
  '可以,继续吧',
  '可以，繼續吧',
  '可以,繼續吧',
  '好的，批准',
  '好的,批准',
  'approve',
  'approved',
  'allow',
  'yes',
  'i approve',
  'i agree',
  'yes, go ahead',
]);
const DENY = new Set([
  '拒绝',
  '拒絕',
  '不批准',
  '不同意',
  '不允许',
  '不允許',
  '不授权',
  '不授權',
  'deny',
  'denied',
  'reject',
  'no',
  'do not allow',
  'do not approve',
]);
const FOREGROUND_ALLOW = new Set([
  '同意前台操作',
  '允许使用前台',
  '允許使用前台',
  '可以用前台',
  '允许这个任务使用前台',
  '允许当前任务使用前台',
  '批准这个任务使用前台',
  '批准当前任务使用前台',
  '授权当前任务使用前台',
  '允許這個任務使用前台',
  '允許當前任務使用前台',
  '批准這個任務使用前台',
  '批准當前任務使用前台',
  '授權當前任務使用前台',
  'allow this task to use the foreground',
  'allow the current task to use the foreground',
  'approve foreground access for this task',
  'authorize foreground access for this task',
]);
const FOREGROUND_DENY = new Set([
  '保持后台',
  '保持後台',
  '不允许这个任务使用前台',
  '不允许当前任务使用前台',
  '不允許這個任務使用前台',
  '不允許當前任務使用前台',
  'keep running in the background',
  'deny foreground access for this task',
]);
const COMPUTER_ALLOW = new Set([
  '允许这个任务使用电脑',
  '允许当前任务使用电脑',
  '允許這個任務使用電腦',
  '允許當前任務使用電腦',
  'allow this task to use the computer',
]);

/** Entire-utterance commands only: a quote, question or added instruction is not consent. */
export function classifyComputerUseAuthorizationText(
  request: InteractionClientCapabilityRequest,
  text: string,
): 'allow' | 'deny' | undefined {
  if (
    request.target.capability !== 'computer_use' ||
    (request.target.scope.kind !== 'capability' &&
      request.target.scope.kind !== 'computer_use_foreground') ||
    typeof text !== 'string' ||
    new TextEncoder().encode(text).byteLength > INTERACTION_AUTHORIZATION_TEXT_MAX_BYTES ||
    /[\r\n\u2028\u2029]/u.test(text)
  )
    return undefined;
  const utterance = text
    .trim()
    .toLowerCase()
    .replace(/[.!。！]$/u, '')
    .trim();
  if (ALLOW.has(utterance)) return 'allow';
  if (DENY.has(utterance)) return 'deny';
  if (request.target.scope.kind === 'computer_use_foreground') {
    if (FOREGROUND_ALLOW.has(utterance)) return 'allow';
    if (FOREGROUND_DENY.has(utterance)) return 'deny';
  } else if (COMPUTER_ALLOW.has(utterance)) return 'allow';
  return undefined;
}
