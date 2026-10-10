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

import { computerActionLabel } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComputerUsePresentation } from '../../../../../shared/computer-use-presentation.js';

const COPY = {
  'zh-CN': {
    computer: '电脑操作', open: '查看电脑', stop: '停止任务', stopFailed: '未能停止，请使用对话中的停止按钮重试。',
    stopping: '正在停止', stopped: '已停止', completed: '本轮电脑操作已结束',
    stoppingDetail: '正在等待当前操作返回。停止完成前，请勿重复操作。',
    empty: '本任务还没有电脑操作', emptyDetail: '助手操作应用后，会在这里显示状态和已捕获的画面。',
    unavailable: '电脑状态暂不可用', unavailableDetail: '请在对话中查看工具结果。',
    noFrame: '尚无可预览的截图', noFrameDetail: '助手获取窗口截图后，会在这里显示最近一次截图。',
    preview: '实时预览', previewStart: '开始实时预览', previewRetry: '重新预览', previewStop: '关闭预览',
    previewStarting: '正在连接预览', previewLive: '实时画面', previewStopped: '预览已关闭',
    previewUnavailable: '实时预览暂不可用', previewIdle: '按需查看实时画面',
    previewIdleDetail: '预览只供你查看；关闭预览不会停止助手。',
    previewPermission: '请检查系统的辅助功能与屏幕录制权限，然后重新打开预览。',
    previewUnsupported: '当前系统暂不支持此窗口的实时预览。',
    previewTarget: '当前窗口暂不可预览，助手观察窗口后可重试。',
    previewChanged: '助手观察窗口后，预览会自动继续。',
    previewLocked: '设备已锁定，解锁后可重新预览。',
    previewFailed: '未能连接窗口画面，请重试。',
    previewHidden: '预览已关闭，重新打开不会影响助手执行。',
    lastFrame: '最近一次截图', frameAlt: '任务最近一次捕获的应用窗口',
  },
  'zh-TW': {
    computer: '電腦操作', open: '檢視電腦', stop: '停止任務', stopFailed: '未能停止，請使用對話中的停止按鈕重試。',
    stopping: '正在停止', stopped: '已停止', completed: '本輪電腦操作已結束',
    stoppingDetail: '正在等待目前操作返回。停止完成前，請勿重複操作。',
    empty: '本任務還沒有電腦操作', emptyDetail: '助手操作應用後，會在這裡顯示狀態和已擷取的畫面。',
    unavailable: '電腦狀態暫不可用', unavailableDetail: '請在對話中檢視工具結果。',
    noFrame: '尚無可預覽的截圖', noFrameDetail: '助手取得視窗截圖後，會在這裡顯示最近一次截圖。',
    preview: '即時預覽', previewStart: '開始即時預覽', previewRetry: '重新預覽', previewStop: '關閉預覽',
    previewStarting: '正在連接預覽', previewLive: '即時畫面', previewStopped: '預覽已關閉',
    previewUnavailable: '即時預覽暫不可用', previewIdle: '按需檢視即時畫面',
    previewIdleDetail: '預覽只供你檢視；關閉預覽不會停止助手。',
    previewPermission: '請檢查系統的輔助使用與螢幕錄製權限，然後重新開啟預覽。',
    previewUnsupported: '目前系統暫不支援此視窗的即時預覽。',
    previewTarget: '目前視窗暫不可預覽，助手觀察視窗後可重試。',
    previewChanged: '助手觀察視窗後，預覽會自動繼續。',
    previewLocked: '裝置已鎖定，解鎖後可重新預覽。',
    previewFailed: '未能連接視窗畫面，請重試。',
    previewHidden: '預覽已關閉，重新開啟不會影響助手執行。',
    lastFrame: '最近一次截圖', frameAlt: '任務最近一次擷取的應用視窗',
  },
  en: {
    computer: 'Computer use', open: 'View computer', stop: 'Stop task', stopFailed: 'Could not stop. Try the Stop button in the conversation.',
    stopping: 'Stopping', stopped: 'Stopped', completed: 'Computer actions finished',
    stoppingDetail: 'Waiting for the current operation to return. Do not repeat it before stopping completes.',
    empty: 'No computer actions in this task yet', emptyDetail: 'Actions and captured frames appear here when the assistant operates an app.',
    unavailable: 'Computer status unavailable', unavailableDetail: 'Check tool results in the conversation.',
    noFrame: 'No captured frame yet', noFrameDetail: 'The latest screenshot appears here after the assistant captures a window screenshot.',
    preview: 'Live preview', previewStart: 'Start live preview', previewRetry: 'Retry preview', previewStop: 'Close preview',
    previewStarting: 'Connecting preview', previewLive: 'Live view', previewStopped: 'Preview closed',
    previewUnavailable: 'Live preview unavailable', previewIdle: 'View the window when needed',
    previewIdleDetail: 'Preview is for your viewing. Closing it does not stop the assistant.',
    previewPermission: 'Check Accessibility and Screen Recording permissions, then reopen preview.',
    previewUnsupported: 'Live preview of this window is not supported on this system.',
    previewTarget: 'This window is not available for preview. Try again after the assistant observes it.',
    previewChanged: 'Preview resumes when the assistant observes the window.',
    previewLocked: 'The device is locked. Unlock it to preview again.',
    previewFailed: 'Could not connect to the window. Try again.',
    previewHidden: 'Preview closed. Reopening it does not affect the assistant.',
    lastFrame: 'Last captured frame', frameAlt: 'Application window last captured by this task',
  },
};

export function computerUseCopy(locale: UiLocale) { return COPY[locale]; }

export function computerUseAction(presentation: ComputerUsePresentation, locale: UiLocale): string {
  return computerActionLabel({ toolName: 'computer', args: { action: presentation.action } }, locale)
    ?? computerUseCopy(locale).computer;
}
