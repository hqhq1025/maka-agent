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

import type { CapabilityReasonCode } from '@maka/core/capabilities';
import { type UiCatalog, type UiLocale, lookupCopy } from '@maka/core/ui-locale';

export type CapabilityReasonCopy = Record<CapabilityReasonCode, string>;

const CAPABILITY_REASON_COPY = {
  'zh-CN': {
    disabled: '该能力当前已关闭。',
    platform_credentials_missing: '未配置平台凭据',
    macos_tcc_only: '仅 macOS TCC 权限适用',
    apple_events_tcc_status_unavailable: 'Electron 暂不支持读取逐 App 的 Apple Events 授权状态',
    cu_artifact_missing: '当前设备上没有可用的 Cua Driver。',
    cu_backend_status: 'Computer Use 通过 Cua Driver 执行。',
    cu_backend_unavailable: '当前桌面环境或权限尚未通过 Cua Driver 检查。',
    cu_executor_undistributable: '当前设备上没有可用的 Cua Driver。',
    cu_executor_stopped: 'Cua Driver 已停止。',
    cu_executor_start_failed: 'Cua Driver 加载失败。请查看运行日志。',
    cu_executor_recovering: '正在加载 Cua Driver。',
    cu_executor_ready: 'Cua Driver 已就绪。',
    cu_executor_lazy_start: 'Cua Driver 将在首次电脑操作时加载。',
    activity_recorder_partial: 'Daily Review 已聚合本地任务 / 工具 / 模型活动；当前不包含屏幕与应用级录制',
    activity_recorder_probe_hint: '打开 Daily Review 可查看本地活动聚合结果',
    memory_partial: '本地 MEMORY.md 已可见；自动抽取/写入仍需用户确认',
    memory_no_probe: '透明本地记忆为文件读写能力，不做后台探测',
    accessibility_status_ambiguous: 'macOS 不区分辅助功能权限是未授权还是未申请',
    screen_recording_status_mac_only: '屏幕录制权限状态仅能在 macOS 上读取',
    notifications_status_unreadable_macos: 'Electron 无法可靠读取 macOS 通知授权状态，请在系统设置中确认',
    notifications_status_unreadable: 'Electron 无法可靠读取当前系统的通知授权状态',
    notifications_unsupported: 'Electron 通知能力不可用',
    permission_probe_failed: '权限探测失败',
  },
  'zh-TW': {
    disabled: '此能力目前已關閉。',
    platform_credentials_missing: '未設定平台憑據',
    macos_tcc_only: '僅 macOS TCC 權限適用',
    apple_events_tcc_status_unavailable: 'Electron 暫不支援讀取逐 App 的 Apple Events 授權狀態',
    cu_artifact_missing: '目前裝置上沒有可用的 Cua Driver。',
    cu_backend_status: 'Computer Use 透過 Cua Driver 執行。',
    cu_backend_unavailable: '目前桌面環境或權限尚未通過 Cua Driver 檢查。',
    cu_executor_undistributable: '目前裝置上沒有可用的 Cua Driver。',
    cu_executor_stopped: 'Cua Driver 已停止。',
    cu_executor_start_failed: 'Cua Driver 載入失敗。請查看執行日誌。',
    cu_executor_recovering: '正在載入 Cua Driver。',
    cu_executor_ready: 'Cua Driver 已就緒。',
    cu_executor_lazy_start: 'Cua Driver 將在首次電腦操作時載入。',
    activity_recorder_partial: 'Daily Review 已彙整本機任務 / 工具 / 模型活動；目前不包含螢幕與應用程式層級錄製',
    activity_recorder_probe_hint: '開啟 Daily Review 可檢視本機活動彙整結果',
    memory_partial: '本機 MEMORY.md 已可見；自動擷取/寫入仍需使用者確認',
    memory_no_probe: '透明本機記憶為檔案讀寫能力，不做背景探測',
    accessibility_status_ambiguous: 'macOS 不區分輔助使用權限是未授權還是未申請',
    screen_recording_status_mac_only: '螢幕錄製權限狀態僅能在 macOS 上讀取',
    notifications_status_unreadable_macos: 'Electron 無法可靠讀取 macOS 通知授權狀態，請在系統設定中確認',
    notifications_status_unreadable: 'Electron 無法可靠讀取目前系統的通知授權狀態',
    notifications_unsupported: 'Electron 通知能力無法使用',
    permission_probe_failed: '權限探測失敗',
  },
  en: {
    disabled: 'This capability is turned off.',
    platform_credentials_missing: 'Platform credentials are not configured',
    macos_tcc_only: 'Only macOS TCC permissions apply',
    apple_events_tcc_status_unavailable: 'Electron cannot read per-app Apple Events authorization status',
    cu_artifact_missing: 'Cua Driver is unavailable on this device.',
    cu_backend_status: 'Computer Use runs through Cua Driver.',
    cu_backend_unavailable: 'The desktop environment or permissions have not passed the Cua Driver check.',
    cu_executor_undistributable: 'Cua Driver is unavailable on this device.',
    cu_executor_stopped: 'Cua Driver has stopped.',
    cu_executor_start_failed: 'Cua Driver failed to load. See the runtime logs.',
    cu_executor_recovering: 'Loading Cua Driver.',
    cu_executor_ready: 'Cua Driver is ready.',
    cu_executor_lazy_start: 'Cua Driver loads on the first computer action.',
    activity_recorder_partial: 'Daily Review aggregates local task, tool, and model activity; screen and app-level recording is not included.',
    activity_recorder_probe_hint: 'Open Daily Review to see the local activity summary.',
    memory_partial: 'The local MEMORY.md is visible; automatic extraction and writes still require confirmation.',
    memory_no_probe: 'Transparent local memory is plain file access, so no background probe runs.',
    accessibility_status_ambiguous: 'macOS does not distinguish denied from never-requested Accessibility permission',
    screen_recording_status_mac_only: 'Screen Recording permission status can only be read on macOS',
    notifications_status_unreadable_macos: 'Electron cannot reliably read macOS notification authorization; check System Settings',
    notifications_status_unreadable: 'Electron cannot reliably read notification authorization on this system',
    notifications_unsupported: 'Electron notifications are unavailable',
    permission_probe_failed: 'Permission probe failed',
  },
} satisfies UiCatalog<CapabilityReasonCopy>;

export function getCapabilityReasonCopy(locale: UiLocale): CapabilityReasonCopy {
  return CAPABILITY_REASON_COPY[locale];
}

export function capabilityReasonMessage(reason: string | undefined, locale: UiLocale): string | undefined {
  return lookupCopy(CAPABILITY_REASON_COPY[locale], reason);
}
