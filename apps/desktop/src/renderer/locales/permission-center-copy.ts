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

import type { StatusSemantic } from '@maka/ui';
import type {
  CapabilityReadinessState,
  CapabilityReasonCode,
  CapabilitySnapshot,
  OsPermissionId,
  OsPermissionState,
  RuntimeProbeState,
} from '@maka/core/capabilities';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { ComputerUseForegroundPolicy } from '@maka/core/settings';

type Tone = StatusSemantic;
type StatusCopy = { label: string; tone: Tone };

export type PermissionCenterCopy = {
  readiness: Record<CapabilityReadinessState, StatusCopy & { detail: string }>;
  osPermissions: Record<OsPermissionId, { label: string; purpose: string; impact: string }>;
  osStates: Record<OsPermissionState, StatusCopy>;
  loading: string;
  readFailed: string;
  noData: string;
  readAgain: string;
  actionFailed: string;
  actionFailures: Record<
    | 'invalid_id'
    | 'unsupported_platform'
    | 'unsupported_permission'
    | 'denied'
    | 'already_open'
    | 'open_settings_failed'
    | 'failed',
    string
  >;
  title: string;
  subtitle: string;
  lastRead: string;
  detectAgain: string;
  summaryAria: string;
  summaryFilterAria(label: string, count: number, selected: boolean): string;
  granted: string;
  pending: string;
  denied: string;
  other: string;
  osSection: string;
  osSectionHelp: string;
  osListAria: string;
  capabilitiesSection: string;
  capabilitiesHelp: string;
  capabilityListAria: string;
  footnote: string;
  computerUseSection: string;
  foregroundPolicy: string;
  foregroundPolicyHelp: string;
  foregroundPolicyOptions: Record<ComputerUseForegroundPolicy, string>;
  foregroundPolicyFailed: string;
  layers: {
    aria(label: string): string;
    feature: string;
    configuration: string;
    approval: string;
    memory: string;
    runtime: string;
    featureStates: Record<CapabilitySnapshot['feature']['state'], string>;
    configurationStates: Record<CapabilitySnapshot['configuration']['state'], string>;
    approvalStates: Record<CapabilitySnapshot['actionApproval']['state'], string>;
    memoryStates: Record<CapabilitySnapshot['memoryAcceptance']['state'], string>;
    runtimeStates: Record<CapabilitySnapshot['runtimeProbe']['state'], string>;
  };
  requiredPermissions: string;
  requiredPermissionsAria(label: string): string;
  auditSection: string;
  noAudit: string;
  auditAria(label: string): string;
  impact: string;
  opening: string;
  openSettings: string;
  requesting: string;
  request: string;
  /** macOS drag-to-grant onboarding (accessibility / screen recording). */
  dragGrant: string;
  dragGranting: string;
  cuBackendStatus(missingPermissionLabels: readonly string[], health: RuntimeProbeState): string;
  reasonFallback: string;
};

const PERMISSION_CENTER_COPY = {
  'zh-CN': {
    readiness: {
      not_configured: { label: '等待配置', detail: '需要先打开开关或补齐配置才能启用。', tone: 'neutral' },
      denied: { label: '系统拒绝', detail: '所需系统权限被拒绝或当前平台不支持。', tone: 'error' },
      enabled: { label: '运行可用', detail: '当前快照标记为可用，具体层级见下方。', tone: 'success' },
      degraded: { label: '部分可用', detail: '已有一部分能力可用，但仍有运行态、权限或子功能需要处理。', tone: 'attention' },
      paused: { label: '已暂停', detail: '功能开关被显式关闭，但配置仍保留。', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: '辅助功能', purpose: 'macOS 上的 Computer Use 需要它来读取和操作应用控件。', impact: 'Computer Use · 读取与操作控件' },
      screen_recording: { label: '屏幕录制', purpose: 'macOS 上的窗口截图和图像确认需要它。未授权时仍可读取和操作应用控件。', impact: 'Computer Use · 截屏与图像确认' },
      notifications: { label: '通知', purpose: '权限申请、回顾完成等系统通知需要它。', impact: '权限申请提醒 · 每日回顾完成通知' },
      automation: { label: '自动化（Apple Events）', purpose: '通过 Apple Events 控制其他应用时，macOS 会按目标应用请求授权。Computer Use 不依赖这项权限。', impact: 'Apple Events 自动化' },
    },
    osStates: {
      unsupported: { label: '当前平台不支持', tone: 'neutral' }, unknown: { label: '无法读取状态', tone: 'neutral' },
      not_determined: { label: '等待授权', tone: 'attention' }, denied: { label: '已拒绝', tone: 'error' }, granted: { label: '已授权', tone: 'success' },
    },
    loading: '正在加载权限快照', readFailed: '无法读取权限快照', noData: '权限服务未返回数据。', readAgain: '重新读取',
    actionFailed: '权限操作失败',
    actionFailures: {
      invalid_id: '内部错误：权限 id 无法识别。',
      unsupported_platform: '当前操作系统不支持这个权限操作。',
      unsupported_permission: '当前平台没有提供这个权限的直接入口。',
      denied: '你没有授予这项权限；可以前往系统设置重新开启。',
      already_open: '另一个权限引导仍在进行，请先完成或关闭它。',
      open_settings_failed: '无法打开系统设置，请手动前往「隐私与安全性」。',
      failed: '权限操作未成功，请稍后重试。',
    },
    title: '权限与能力', subtitle: '查看当前设备的系统权限、功能状态和需要处理的事项。',
    lastRead: '最近读取：', detectAgain: '重新检测', summaryAria: '按授权状态筛选系统权限', summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 项，当前筛选；再次按下显示全部` : `仅显示${label}权限，共 ${count} 项`, granted: '已授权', pending: '等待授权', denied: '已拒绝', other: '未知 / 不支持',
    osSection: '系统权限', osSectionHelp: '当前操作系统提供的权限状态。可用时，使用右侧按钮申请权限或打开对应设置；不适用的权限会单独标明。', osListAria: '系统权限列表',
    capabilitiesSection: '功能能力', capabilitiesHelp: '每个能力的就绪状态由「功能开关 · 配置 · 系统权限 · 运行态探测」共同决定。',
    capabilityListAria: '功能能力列表',
    computerUseSection: '电脑操作',
    foregroundPolicy: '使用前台',
    foregroundPolicyHelp: '默认在后台操作。这项设置只影响需要使用前台的操作，并保存在这台电脑上；选择询问时，一次授权覆盖当前任务。',
    foregroundPolicyOptions: { never: '禁止前台', ask: '使用前台前询问（默认）', allow: '允许前台' },
    foregroundPolicyFailed: '无法读取或保存前台设置',
    footnote: '系统权限由操作系统管理，与任务中的操作授权分别生效。macOS 修改辅助功能或屏幕录制授权后，请完全退出并重新打开 App。这里显示最近一次检测的状态；Computer Use 还会在操作前检查桌面环境和目标应用。',
    layers: {
      aria: (label) => `${label}能力状态明细`, feature: '功能开关', configuration: '配置', approval: '操作审批', memory: '记忆写入', runtime: '运行态探测',
      featureStates: { enabled: '已开启', partial: '部分可用', disabled: '已关闭', not_available: '未开放' },
      configurationStates: { not_required: '不需要配置', missing: '等待补齐配置', present: '已填写' },
      approvalStates: { not_required: '不需要审批', required_per_action: '每次调用都需审批', required_scoped_lease: '按目标与动作类别授权', pending: '审批挂起', approved: '当前任务已批准', denied: '当前任务已拒绝' },
      memoryStates: { not_applicable: '不涉及记忆写入', disabled: '记忆写入已关闭', draft_required: '需要先草拟 memory 协议', accepted: '记忆写入已接受' },
      runtimeStates: { not_available: '尚无运行态探测', not_run: '探测未运行', healthy: '探测通过', degraded: '探测降级' },
    },
    requiredPermissions: '相关系统权限', requiredPermissionsAria: (label) => `${label}相关系统权限列表`,
    auditSection: '审计记录', noAudit: '暂无审计记录', auditAria: (label) => `${label}审计记录列表`,
    impact: '影响功能', opening: '打开中…', openSettings: '前往系统设置', requesting: '请求中…', request: '请求授权', dragGrant: '引导授权', dragGranting: '引导中…',
    cuBackendStatus: (missing, health) =>
      (missing.length > 0 ? `等待${missing.join('、')}权限。` : '')
      + ({
        not_available: 'Cua Driver 未能加载或已停止。请查看运行日志。',
        degraded: 'Cua Driver 尚未就绪，正在加载或需要处理桌面环境与权限。',
        healthy: 'Cua Driver 已就绪；操作前仍会检查目标应用和操作授权。',
        not_run: 'Cua Driver 将在首次电脑操作时加载，并检查桌面环境与权限。',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: '状态详情请查看运行日志。',
  },
  'zh-TW': {
    readiness: {
      not_configured: { label: '等待設定', detail: '需要先開啟開關或補齊設定才能啟用。', tone: 'neutral' },
      denied: { label: '系統拒絕', detail: '所需系統權限被拒絕或目前平臺不支援。', tone: 'error' },
      enabled: { label: '執行可用', detail: '目前快照標記為可用，具體層級見下方。', tone: 'success' },
      degraded: { label: '部分可用', detail: '已有一部分能力可用，但仍有執行態、權限或子功能需要處理。', tone: 'attention' },
      paused: { label: '已暫停', detail: '功能開關被顯式關閉，但設定仍保留。', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: '輔助功能', purpose: 'macOS 上的 Computer Use 需要它來讀取和操作應用程式控制項。', impact: 'Computer Use · 讀取與操作控制項' },
      screen_recording: { label: '螢幕錄製', purpose: 'macOS 上的視窗截圖和影像確認需要它。未授權時仍可讀取和操作應用程式控制項。', impact: 'Computer Use · 截圖與影像確認' },
      notifications: { label: '通知', purpose: '權限申請、回顧完成等系統通知需要它。', impact: '權限申請提醒 · 每日回顧完成通知' },
      automation: { label: '自動化（Apple Events）', purpose: '透過 Apple Events 控制其他應用程式時，macOS 會依目標應用程式請求授權。Computer Use 不依賴這項權限。', impact: 'Apple Events 自動化' },
    },
    osStates: {
      unsupported: { label: '目前平臺不支援', tone: 'neutral' }, unknown: { label: '無法讀取狀態', tone: 'neutral' },
      not_determined: { label: '等待授權', tone: 'attention' }, denied: { label: '已拒絕', tone: 'error' }, granted: { label: '已授權', tone: 'success' },
    },
    loading: '正在載入權限快照', readFailed: '無法讀取權限快照', noData: '權限服務未返回資料。', readAgain: '重新讀取',
    actionFailed: '權限操作失敗',
    actionFailures: {
      invalid_id: '內部錯誤：權限 id 無法識別。',
      unsupported_platform: '目前作業系統不支援這個權限操作。',
      unsupported_permission: '目前平臺沒有提供這個權限的直串接口。',
      denied: '你沒有授予這項權限；可以前往系統設定重新開啟。',
      already_open: '另一個權限引導仍在進行，請先完成或關閉它。',
      open_settings_failed: '無法開啟系統設定，請手動前往「隱私與安全性」。',
      failed: '權限操作未成功，請稍後重試。',
    },
    title: '權限與能力', subtitle: '檢視目前裝置的系統權限、功能狀態和需要處理的事項。',
    lastRead: '最近讀取：', detectAgain: '重新檢測', summaryAria: '按授權狀態篩選系統權限', summaryFilterAria: (label, count, selected) => selected ? `${label} ${count} 項，目前篩選；再次按下顯示全部` : `僅顯示${label}權限，共 ${count} 項`, granted: '已授權', pending: '等待授權', denied: '已拒絕', other: '未知 / 不支援',
    osSection: '系統權限', osSectionHelp: '目前作業系統提供的權限狀態。可用時，使用右側按鈕申請權限或開啟對應設定；不適用的權限會另外標示。', osListAria: '系統權限列表',
    capabilitiesSection: '功能能力', capabilitiesHelp: '每個能力的就緒狀態由「功能開關 · 設定 · 系統權限 · 執行態探測」共同決定。',
    capabilityListAria: '功能能力列表',
    computerUseSection: '電腦操作',
    foregroundPolicy: '使用前景',
    foregroundPolicyHelp: '預設在背景操作。這項設定只影響需要使用前景的操作，並儲存在這台電腦上；選擇詢問時，一次授權涵蓋目前任務。',
    foregroundPolicyOptions: { never: '禁止前景', ask: '使用前景前詢問（預設）', allow: '允許前景' },
    foregroundPolicyFailed: '無法讀取或儲存前景設定',
    footnote: '系統權限由作業系統管理，與任務中的操作授權分別生效。macOS 修改輔助功能或螢幕錄製授權後，請完全結束並重新開啟 App。這裡顯示最近一次檢測的狀態；Computer Use 還會在操作前檢查桌面環境和目標應用程式。',
    layers: {
      aria: (label) => `${label}能力狀態明細`, feature: '功能開關', configuration: '設定', approval: '操作審批', memory: '記憶寫入', runtime: '執行態探測',
      featureStates: { enabled: '已開啟', partial: '部分可用', disabled: '已關閉', not_available: '未開放' },
      configurationStates: { not_required: '不需要設定', missing: '等待補齊設定', present: '已填寫' },
      approvalStates: { not_required: '不需要審批', required_per_action: '每次呼叫都需審批', required_scoped_lease: '按目標與動作類別授權', pending: '審批掛起', approved: '目前任務已批准', denied: '目前任務已拒絕' },
      memoryStates: { not_applicable: '不涉及記憶寫入', disabled: '記憶寫入已關閉', draft_required: '需要先草擬 memory 協議', accepted: '記憶寫入已接受' },
      runtimeStates: { not_available: '尚無執行態探測', not_run: '探測未執行', healthy: '探測透過', degraded: '探測降級' },
    },
    requiredPermissions: '相關系統權限', requiredPermissionsAria: (label) => `${label}相關系統權限列表`,
    auditSection: '審計記錄', noAudit: '暫無審計記錄', auditAria: (label) => `${label}審計記錄列表`,
    impact: '影響功能', opening: '開啟中…', openSettings: '前往系統設定', requesting: '請求中…', request: '請求授權', dragGrant: '引導授權', dragGranting: '引導中…',
    cuBackendStatus: (missing, health) =>
      (missing.length > 0 ? `等待${missing.join('、')}權限。` : '')
      + ({
        not_available: 'Cua Driver 未能載入或已停止。請查看執行日誌。',
        degraded: 'Cua Driver 尚未就緒，正在載入或需要處理桌面環境與權限。',
        healthy: 'Cua Driver 已就緒；操作前仍會檢查目標應用程式和操作授權。',
        not_run: 'Cua Driver 將在首次電腦操作時載入，並檢查桌面環境與權限。',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: '狀態詳情請查看執行日誌。',
  },
  en: {
    readiness: {
      not_configured: { label: 'Needs setup', detail: 'Enable the feature or complete its configuration first.', tone: 'neutral' },
      denied: { label: 'Denied by system', detail: 'A required system permission was denied or is unsupported on this platform.', tone: 'error' },
      enabled: { label: 'Available', detail: 'The current snapshot is available; see the layers below for details.', tone: 'success' },
      degraded: { label: 'Partially available', detail: 'Some functionality is available, but runtime, permission, or sub-feature work remains.', tone: 'attention' },
      paused: { label: 'Paused', detail: 'The feature was explicitly disabled while its configuration remains saved.', tone: 'neutral' },
    },
    osPermissions: {
      accessibility: { label: 'Accessibility', purpose: 'On macOS, Computer Use needs it to read and operate app controls.', impact: 'Computer Use · read and operate controls' },
      screen_recording: { label: 'Screen Recording', purpose: 'On macOS, window screenshots and visual verification need it. App controls can still be read and operated without it.', impact: 'Computer Use · screenshots and visual verification' },
      notifications: { label: 'Notifications', purpose: 'System alerts use it for permission requests and completed reviews.', impact: 'Permission alerts · Daily Review completion' },
      automation: { label: 'Automation (Apple Events)', purpose: 'macOS requests permission for each app controlled through Apple Events. Computer Use does not require this permission.', impact: 'Apple Events automation' },
    },
    osStates: {
      unsupported: { label: 'Unsupported on this platform', tone: 'neutral' }, unknown: { label: 'Status unavailable', tone: 'neutral' },
      not_determined: { label: 'Waiting for permission', tone: 'attention' }, denied: { label: 'Denied', tone: 'error' }, granted: { label: 'Granted', tone: 'success' },
    },
    loading: 'Loading permission snapshot', readFailed: 'Could not read permission snapshot', noData: 'The permission service returned no data.', readAgain: 'Read again',
    actionFailed: 'Permission action failed',
    actionFailures: {
      invalid_id: 'Internal error: the permission ID was not recognized.',
      unsupported_platform: 'This operating system does not support the permission action.',
      unsupported_permission: 'This platform does not provide a direct entry point for the permission.',
      denied: 'Permission was not granted. You can enable it in System Settings.',
      already_open: 'Another permission guide is still open. Finish or close it first.',
      open_settings_failed: 'Could not open System Settings. Open Privacy & Security manually.',
      failed: 'The permission action did not succeed. Try again later.',
    },
    title: 'Permissions and capabilities', subtitle: 'Review system permissions, feature status, and anything that needs attention on this device.',
    lastRead: 'Last read: ', detectAgain: 'Check again', summaryAria: 'Filter system permissions by authorization status', summaryFilterAria: (label, count, selected) => selected ? `${label}, ${count}; filter selected. Press again to show all permissions` : `Show only ${label.toLowerCase()} permissions, ${count}`, granted: 'Granted', pending: 'Waiting', denied: 'Denied', other: 'Unknown / unsupported',
    osSection: 'System permissions', osSectionHelp: 'Permission states reported by this operating system. Where available, use the actions on the right to request access or open settings. Permissions that do not apply are marked separately.', osListAria: 'System permission list',
    capabilitiesSection: 'Feature capabilities', capabilitiesHelp: 'Each readiness state combines the feature toggle, configuration, system permissions, and runtime probe.',
    capabilityListAria: 'Feature capability list',
    computerUseSection: 'Computer Use',
    foregroundPolicy: 'Foreground access',
    foregroundPolicyHelp: 'Actions use the background by default. This setting applies when an action needs the foreground and is saved on this computer. When set to ask, one approval covers the current task.',
    foregroundPolicyOptions: { never: 'Never allow foreground', ask: 'Ask before foreground (default)', allow: 'Allow foreground' },
    foregroundPolicyFailed: 'Could not read or save foreground settings',
    footnote: 'System permissions apply separately from task action approval. After changing Accessibility or Screen Recording grants on macOS, fully quit and reopen the app. This page shows the latest detected state; Computer Use also checks the desktop environment and target app before acting.',
    layers: {
      aria: (label) => `${label} capability state details`, feature: 'Feature toggle', configuration: 'Configuration', approval: 'Action approval', memory: 'Memory writes', runtime: 'Runtime probe',
      featureStates: { enabled: 'Enabled', partial: 'Partially available', disabled: 'Disabled', not_available: 'Unavailable' },
      configurationStates: { not_required: 'No configuration needed', missing: 'Configuration required', present: 'Configured' },
      approvalStates: { not_required: 'No approval needed', required_per_action: 'Approval required for every call', required_scoped_lease: 'Authorized by target and action category', pending: 'Approval pending', approved: 'Approved for this task', denied: 'Denied for this task' },
      memoryStates: { not_applicable: 'No memory writes', disabled: 'Memory writes disabled', draft_required: 'Draft a memory protocol first', accepted: 'Memory writes accepted' },
      runtimeStates: { not_available: 'No runtime probe available', not_run: 'Probe not run', healthy: 'Probe passed', degraded: 'Probe degraded' },
    },
    requiredPermissions: 'Related system permissions', requiredPermissionsAria: (label) => `${label} related system permissions`,
    auditSection: 'Audit records', noAudit: 'No audit records', auditAria: (label) => `${label} audit records`,
    impact: 'Affects', opening: 'Opening…', openSettings: 'Open System Settings', requesting: 'Requesting…', request: 'Request permission', dragGrant: 'Guide me', dragGranting: 'Opening…',
    cuBackendStatus: (missing, health) =>
      (missing.length > 0 ? `Waiting for ${missing.join(', ')} permission. ` : '')
      + ({
        not_available: 'Cua Driver could not load or has stopped. See the runtime logs.',
        degraded: 'Cua Driver is not ready: it is loading, or the desktop environment or permissions need attention.',
        healthy: 'Cua Driver is ready; target apps and action approvals are still checked before acting.',
        not_run: 'Cua Driver loads on the first computer action and checks the desktop environment and permissions.',
      } satisfies Record<RuntimeProbeState, string>)[health],
    reasonFallback: 'See the runtime logs for details.',
  },
} satisfies UiCatalog<PermissionCenterCopy>;

export function getPermissionCenterCopy(locale: UiLocale): PermissionCenterCopy {
  return PERMISSION_CENTER_COPY[locale];
}
