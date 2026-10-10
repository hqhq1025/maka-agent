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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type BackgroundTerminalStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'orphaned';
type WebCredentialCopyKey = 'env' | 'settings' | 'missing' | 'unknown';
type WebGuidanceKey = 'env' | 'settings' | 'rate_limited' | 'not_configured' | 'timed_out' | 'privacy_mode' | 'unknown';
export type ComputerActionKind =
  | 'inspect' | 'open' | 'capture' | 'click' | 'doubleClick' | 'fill' | 'select'
  | 'scroll' | 'window' | 'key' | 'wait' | 'pointer' | 'operate';
export type ComputerActionState = 'running' | 'confirmed' | 'unconfirmed' | 'notStarted' | 'failed' | 'noChange' | 'unrecorded' | 'authorized' | 'stopped';

export interface ToolActivityCopy {
  errorLabel: string;
  /** The two outcomes a tool row spells out next to its name. */
  status: {
    sandboxBlocked: string;
    interrupted: string;
  };
  output: {
    redacted: string;
    truncated: string;
  };
  copy: {
    idle: string;
    pending: string;
    copied: string;
    failed: string;
    actionAriaLabel: (action: string, identity: string) => string;
  };
  sandboxBlocked: {
    title: string;
    description: string;
    copyAriaLabel: (label: string) => string;
  };
  requiresBypass: {
    title: string;
    description: string;
    errorMessage: string;
    action: string;
    pending: string;
  };
  /** Generic operation wording; control IDs and parameters stay in details. */
  computer: {
    actions: Record<ComputerActionKind, { label: string; running: string }>;
    targetName: (name: string) => string;
    foregroundAuthorized: string;
    states: Record<ComputerActionState, string>;
    diagnostics: string;
    duration: (value: string) => string;
    runningSequence: (current: number, total: number, target?: string) => string;
  };
  loadTools: {
    displayName: string;
    genericAction: string;
    genericTitle: string;
    genericDescription: string;
    fallbackLabel: string;
    namedAction: (label: string) => string;
    namedTitle: (label: string) => string;
    count: (count: number) => string;
    technicalDetails: string;
    groupId: string;
    toolIds: string;
    groups: Record<
      'browser' | 'computer_use' | 'mcp' | 'rive' | 'agent' | 'settings',
      {
        label: string;
        action: string;
        title: string;
        description: string;
      }
    >;
  };
  permissionDenied: string;
  result: {
    hiddenLines: (count: number) => string;
    ptyFailed: string;
    queued: string;
    notQueued: string;
    queuedPreview: (action: string, preview: string, bytes?: number) => string;
    byteCount: (action: string, bytes: number) => string;
    resizeNotApplied: (size: string) => string;
    resized: (size: string) => string;
    sizeUnchanged: (size: string) => string;
    ptyCompleted: string;
    terminalUnavailable: string;
    noTerminalFrame: string;
    noOutputYet: string;
    noOutput: string;
    exitCode: (code: number) => string;
    managedBySource: string;
    sourceUnavailable: string;
    running: string;
    success: string;
    failed: string;
    timedOut: string;
    cancelled: string;
    disconnected: string;
    terminalTruncated: string;
    terminalRedacted: string;
    streamHidden: (stream: 'stdout' | 'stderr', count: number) => string;
    streamsTruncated: (limit: number) => string;
    outputTruncated: string;
    outputRedacted: string;
    backgroundStatus: Record<BackgroundTerminalStatus, string>;
    backgroundUnknown: (status: string) => string;
    workflow: { action: string; status: string; error: string; nodes: string; diagnostics: string };
    workflowCompleted: string;
    workflowFailed: string;
    fileWritten: (bytes: number, path: string) => string;
    webNoResults: string;
    webResults: (count: number) => string;
    credentialSource: Record<WebCredentialCopyKey, string>;
    webFailure: string;
    webSearch: string;
    webGuidance: Record<WebGuidanceKey, string>;
  };
  agent: {
    subagentStatus: Record<
      'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user',
      string
    >;
    readOnly: string;
  };
}

const TOOL_ACTIVITY_COPY = {
  'zh-CN': {
    errorLabel: '错误',
    status: { sandboxBlocked: '可能被沙箱阻止', interrupted: '已中断' },
    output: { redacted: '[已脱敏]', truncated: '输出已截断' },
    copy: {
      idle: '复制',
      pending: '复制中…',
      copied: '已复制',
      failed: '复制失败',
      actionAriaLabel: (action, identity) => `${action}：${identity}`,
    },
    sandboxBlocked: { title: '操作可能被沙箱阻止', description: '沙箱可能阻止了该调用中的至少一项操作。失败前可能已经产生部分结果，请检查输出和工作区状态后再决定是否重试。', copyAriaLabel: (label) => `${label}沙箱诊断信息` },
    requiresBypass: {
      title: '需要“绕过”模式',
      description: '此操作会直接控制本机应用，无法在沙箱模式下执行。',
      errorMessage: '需要“绕过”模式。此操作会直接控制本机应用，无法在沙箱模式下执行。',
      action: '切换并重试',
      pending: '正在切换…',
    },
    computer: {
      actions: {
        inspect: { label: '检查窗口', running: '正在检查窗口' },
        open: { label: '打开应用', running: '正在打开应用' },
        capture: { label: '查看窗口截图', running: '正在查看窗口截图' },
        click: { label: '点击', running: '正在点击' },
        doubleClick: { label: '双击', running: '正在双击' },
        fill: { label: '填写内容', running: '正在填写内容' },
        select: { label: '选择文本', running: '正在选择文本' },
        scroll: { label: '滚动', running: '正在滚动' },
        window: { label: '调整窗口', running: '正在调整窗口' },
        key: { label: '使用键盘', running: '正在使用键盘' },
        wait: { label: '等待', running: '正在等待' },
        pointer: { label: '操作鼠标', running: '正在操作鼠标' },
        operate: { label: '操作电脑', running: '正在操作电脑' },
      },
      targetName: (name) => `「${name}」`,
      foregroundAuthorized: '前台操作已获准',
      states: {
        running: '进行中', confirmed: '已确认', unconfirmed: '效果未确认',
        notStarted: '未执行', failed: '未完成', noChange: '未确认变化',
        unrecorded: '结果未记录', authorized: '尚未操作', stopped: '已停止',
      },
      diagnostics: '操作日志',
      duration: (value) => `耗时：${value}`,
      runningSequence: (current, total, target) =>
        target
          ? `正在操作${target} · 连续操作第 ${current}/${total} 步`
          : `正在连续操作第 ${current}/${total} 步`,
    },
    loadTools: {
      displayName: '启用能力',
      genericAction: '启用工具能力',
      genericTitle: '工具能力已启用',
      genericDescription: '现在可以使用这组工具。',
      fallbackLabel: '工具',
      namedAction: (label) => `启用 ${label}`,
      namedTitle: (label) => `${label} 已启用`,
      count: (n) => `${n} 项能力可用`,
      technicalDetails: '技术详情',
      groupId: '工具组',
      toolIds: '工具',
      groups: {
        browser: { label: 'Browser', action: '启用浏览器操作', title: '浏览器操作已启用', description: '可以打开页面、读取内容并与网页交互。' },
        computer_use: { label: 'Computer Use', action: '启用桌面操作', title: '桌面操作已启用', description: '可以查看和操作已授权的本地应用。' },
        mcp: { label: 'MCP', action: '连接 MCP', title: 'MCP 工具已连接', description: '可以调用当前客户端连接的 MCP 服务。' },
        rive: { label: 'Rive', action: '启用 Rive 工作流', title: 'Rive 工作流已启用', description: '可以运行可恢复的多智能体工作流。' },
        agent: { label: 'Agent', action: '启用子智能体', title: '子智能体协作已启用', description: '可以并行分派、跟踪和汇总子任务。' },
        settings: { label: '设置', action: '启用设置工具', title: '设置工具已启用', description: '可以读取或更新当前客户端设置。' },
      },
    },
    permissionDenied: '用户已拒绝权限请求',
    result: {
      hiddenLines: (n) => `… 已隐藏 ${n} 行`, ptyFailed: '后台终端交互失败', queued: '已输入', notQueued: '未输入', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}：${preview}` : `${action}：${preview}… · 共 ${bytes} 字节`, byteCount: (action, bytes) => `${action} ${bytes} 字节`, resizeNotApplied: (size) => `未调整为 ${size}`, resized: (size) => `已调整为 ${size}`, sizeUnchanged: (size) => `尺寸已是 ${size}`, ptyCompleted: '后台终端交互已完成', terminalUnavailable: '终端输出不可用', noTerminalFrame: '（无可用终端画面）', noOutputYet: '（尚无输出）', noOutput: '（无输出）', exitCode: (code) => `退出码 ${code}`, managedBySource: '由源任务管理', sourceUnavailable: '源任务不可用', running: '运行中', success: '成功', failed: '失败', timedOut: '已超时', cancelled: '已取消', disconnected: '已断开', terminalTruncated: '终端输出已截断', terminalRedacted: '终端输出已脱敏', streamHidden: (stream, n) => `… ${stream} 已隐藏 ${n} 行`, streamsTruncated: (limit) => `输出已截断 · 每路仅展示前 ${limit} 行`, outputTruncated: '输出已截断', outputRedacted: '输出已脱敏',
      backgroundStatus: { running: '后台运行中', completed: '后台已完成', failed: '后台失败', timed_out: '后台超时', cancelled: '后台已取消', orphaned: '后台任务已断开' }, backgroundUnknown: (status) => `后台 · ${status}`,
      workflow: { action: '动作', status: '状态', error: '错误', nodes: '节点摘要', diagnostics: '诊断片段' }, webNoResults: '没有结果', webResults: (n) => `${n} 条结果`, credentialSource: { env: '环境变量', settings: '本机已保存 key', missing: '未配置', unknown: '来源未知' }, webFailure: '搜索失败', webSearch: '联网搜索', webGuidance: { env: '请检查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 后重启。', settings: '请在 设置 · 联网搜索 中更新 Tavily key。', rate_limited: 'Tavily 当前限流，请稍后重试或更换可用凭据。', not_configured: '请先完成联网搜索配置后再重试。', timed_out: '请求超时，请稍后重试。', privacy_mode: '隐私模式下不会发起联网搜索。', unknown: '请检查网络或稍后重试。' },
      workflowCompleted: 'Rive 工作流已完成',
      workflowFailed: 'Rive 工作流执行失败',
      fileWritten: (bytes, path) => `已向 ${path} 写入 ${bytes} 字节`,
    },
    agent: {
      subagentStatus: { completed: '已完成', failed: '失败', cancelled: '已取消', running: '运行中', waiting_for_user: '等待用户输入' },
      readOnly: '只读',
    },
  },
  'zh-TW': {
    errorLabel: '錯誤',
    status: { sandboxBlocked: '可能被沙箱阻止', interrupted: '已中斷' },
    output: { redacted: '[已脫敏]', truncated: '輸出已截斷' },
    copy: {
      idle: '複製',
      pending: '複製中…',
      copied: '已複製',
      failed: '複製失敗',
      actionAriaLabel: (action, identity) => `${action}：${identity}`,
    },
    sandboxBlocked: { title: '操作可能被沙箱阻止', description: '沙箱可能阻止了該呼叫中的至少一項操作。失敗前可能已經產生部分結果，請檢查輸出和工作區狀態後再決定是否重試。', copyAriaLabel: (label) => `${label}沙箱診斷資訊` },
    requiresBypass: {
      title: '需要“繞過”模式',
      description: '此操作會直接控制本機應用，無法在沙箱模式下執行。',
      errorMessage: '需要“繞過”模式。此操作會直接控制本機應用，無法在沙箱模式下執行。',
      action: '切換並重試',
      pending: '正在切換…',
    },
    computer: {
      actions: {
        inspect: { label: '檢查視窗', running: '正在檢查視窗' },
        open: { label: '開啟應用', running: '正在開啟應用' },
        capture: { label: '檢視視窗截圖', running: '正在檢視視窗截圖' },
        click: { label: '點選', running: '正在點選' },
        doubleClick: { label: '雙擊', running: '正在雙擊' },
        fill: { label: '填寫內容', running: '正在填寫內容' },
        select: { label: '選擇文字', running: '正在選擇文字' },
        scroll: { label: '捲動', running: '正在捲動' },
        window: { label: '調整視窗', running: '正在調整視窗' },
        key: { label: '使用鍵盤', running: '正在使用鍵盤' },
        wait: { label: '等待', running: '正在等待' },
        pointer: { label: '操作滑鼠', running: '正在操作滑鼠' },
        operate: { label: '操作電腦', running: '正在操作電腦' },
      },
      targetName: (name) => `「${name}」`,
      foregroundAuthorized: '前台操作已獲准',
      states: {
        running: '進行中', confirmed: '已確認', unconfirmed: '效果未確認',
        notStarted: '未執行', failed: '未完成', noChange: '未確認變化',
        unrecorded: '結果未記錄', authorized: '尚未操作', stopped: '已停止',
      },
      diagnostics: '操作日誌',
      duration: (value) => `耗時：${value}`,
      runningSequence: (current, total, target) =>
        target
          ? `正在操作${target} · 連續操作第 ${current}/${total} 步`
          : `正在連續操作第 ${current}/${total} 步`,
    },
    loadTools: {
      displayName: '啟用能力',
      genericAction: '啟用工具能力',
      fallbackLabel: '工具',
      namedAction: (label) => `啟用 ${label}`,
      namedTitle: (label) => `${label} 已啟用`,
      genericTitle: '工具能力已啟用',
      genericDescription: '現在可以使用這組工具。',
      count: (n) => `${n} 項能力可用`,
      technicalDetails: '技術詳情',
      groupId: '工具組',
      toolIds: '工具',
      groups: {
        browser: { label: 'Browser', action: '啟用瀏覽器操作', title: '瀏覽器操作已啟用', description: '可以開啟頁面、讀取內容並與網頁互動。' },
        computer_use: { label: 'Computer Use', action: '啟用桌面操作', title: '桌面操作已啟用', description: '可以檢視和操作已授權的本地應用。' },
        mcp: { label: 'MCP', action: '連線 MCP', title: 'MCP 工具已連線', description: '可以呼叫目前客戶端連線的 MCP 服務。' },
        rive: { label: 'Rive', action: '啟用 Rive 工作流', title: 'Rive 工作流已啟用', description: '可以執行可恢復的多智慧體工作流。' },
        agent: { label: 'Agent', action: '啟用子智慧體', title: '子智慧體協作已啟用', description: '可以並行分派、跟蹤和彙總子任務。' },
        settings: { label: '設定', action: '啟用設定工具', title: '設定工具已啟用', description: '可以讀取或更新目前客戶端設定。' },
      },
    },
    permissionDenied: '使用者已拒絕權限請求',
    result: {
      hiddenLines: (n) => `… 已隱藏 ${n} 行`, ptyFailed: '後臺終端互動失敗', queued: '已輸入', notQueued: '未輸入', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}：${preview}` : `${action}：${preview}… · 共 ${bytes} 位元組`, byteCount: (action, bytes) => `${action} ${bytes} 位元組`, resizeNotApplied: (size) => `未調整為 ${size}`, resized: (size) => `已調整為 ${size}`, sizeUnchanged: (size) => `尺寸已是 ${size}`, ptyCompleted: '後臺終端互動已完成', terminalUnavailable: '終端輸出不可用', noTerminalFrame: '（無可用終端畫面）', noOutputYet: '（尚無輸出）', noOutput: '（無輸出）', exitCode: (code) => `退出碼 ${code}`, managedBySource: '由源任務管理', sourceUnavailable: '源任務不可用', running: '執行中', success: '成功', failed: '失敗', timedOut: '已超時', cancelled: '已取消', disconnected: '已斷開', terminalTruncated: '終端輸出已截斷', terminalRedacted: '終端輸出已脫敏', streamHidden: (stream, n) => `… ${stream} 已隱藏 ${n} 行`, streamsTruncated: (limit) => `輸出已截斷 · 每路僅展示前 ${limit} 行`, outputTruncated: '輸出已截斷', outputRedacted: '輸出已脫敏',
      backgroundStatus: { running: '後臺執行中', completed: '後臺已完成', failed: '後臺失敗', timed_out: '後臺超時', cancelled: '後臺已取消', orphaned: '後臺任務已斷開' }, backgroundUnknown: (status) => `後臺 · ${status}`,
      workflow: { action: '動作', status: '狀態', error: '錯誤', nodes: '節點摘要', diagnostics: '診斷片段' }, webNoResults: '沒有結果', webResults: (n) => `${n} 條結果`, credentialSource: { env: '環境變數', settings: '本機已儲存 key', missing: '未設定', unknown: '來源未知' }, webFailure: '搜尋失敗', webSearch: '聯網搜尋', webGuidance: { env: '請檢查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 後重啟。', settings: '請在 設定 · 聯網搜尋 中更新 Tavily key。', rate_limited: 'Tavily 目前限流，請稍後重試或更換可用憑據。', not_configured: '請先完成聯網搜尋設定後再重試。', timed_out: '請求超時，請稍後重試。', privacy_mode: '隱私模式下不會發起聯網搜尋。', unknown: '請檢查網路或稍後重試。' },
      workflowCompleted: 'Rive 工作流已完成',
      workflowFailed: 'Rive 工作流執行失敗',
      fileWritten: (bytes, path) => `已向 ${path} 寫入 ${bytes} 位元組`,
    },
    agent: {
      subagentStatus: { completed: '已完成', failed: '失敗', cancelled: '已取消', running: '執行中', waiting_for_user: '等待使用者輸入' },
      readOnly: '只讀',
    },
  },
  en: {
    errorLabel: 'Error',
    status: { sandboxBlocked: 'Possibly blocked by sandbox', interrupted: 'Interrupted' },
    output: { redacted: '[Redacted]', truncated: 'Output truncated' },
    copy: {
      idle: 'Copy',
      pending: 'Copying…',
      copied: 'Copied',
      failed: 'Copy failed',
      actionAriaLabel: (action, identity) => `${action}: ${identity}`,
    },
    sandboxBlocked: { title: 'Operation may have been blocked by sandbox', description: 'The sandbox may have blocked at least one action in this call. Some effects may have occurred before it failed; check the output and workspace state before retrying.', copyAriaLabel: (label) => `${label} sandbox diagnostics` },
    requiresBypass: {
      title: 'Bypass mode required',
      description: 'This action controls a local app directly and cannot run inside the sandbox.',
      errorMessage: 'Bypass mode required. This action controls a local app directly and cannot run inside the sandbox.',
      action: 'Switch and retry',
      pending: 'Switching…',
    },
    computer: {
      actions: {
        inspect: { label: 'Check a window', running: 'Checking a window' },
        open: { label: 'Open an app', running: 'Opening an app' },
        capture: { label: 'View a window screenshot', running: 'Viewing a window screenshot' },
        click: { label: 'Click', running: 'Clicking' },
        doubleClick: { label: 'Double-click', running: 'Double-clicking' },
        fill: { label: 'Fill in content', running: 'Filling in content' },
        select: { label: 'Select text', running: 'Selecting text' },
        scroll: { label: 'Scroll', running: 'Scrolling' },
        window: { label: 'Adjust a window', running: 'Adjusting a window' },
        key: { label: 'Use the keyboard', running: 'Using the keyboard' },
        wait: { label: 'Wait', running: 'Waiting' },
        pointer: { label: 'Use the mouse', running: 'Using the mouse' },
        operate: { label: 'Use the computer', running: 'Using the computer' },
      },
      targetName: (name) => `“${name}”`,
      foregroundAuthorized: 'Foreground access authorized',
      states: {
        running: 'In progress', confirmed: 'Confirmed', unconfirmed: 'Effect unconfirmed',
        notStarted: 'Not performed', failed: 'Not completed', noChange: 'Change unconfirmed',
        unrecorded: 'Result not recorded', authorized: 'No input sent', stopped: 'Stopped',
      },
      diagnostics: 'Operation log',
      duration: (value) => `Duration: ${value}`,
      runningSequence: (current, total, target) =>
        target
          ? `Operating ${target} · step ${current}/${total}`
          : `Operating controls · step ${current}/${total}`,
    },
    loadTools: {
      displayName: 'Enable capabilities',
      genericAction: 'Enable tool capabilities',
      genericTitle: 'Tool capabilities enabled',
      genericDescription: 'This tool group is ready to use.',
      fallbackLabel: 'Tools',
      namedAction: (label) => `Enable ${label}`,
      namedTitle: (label) => `${label} enabled`,
      count: (n) => `${n} ${n === 1 ? 'capability' : 'capabilities'} available`,
      technicalDetails: 'Technical details',
      groupId: 'Group',
      toolIds: 'Tools',
      groups: {
        browser: { label: 'Browser', action: 'Enable browser actions', title: 'Browser actions enabled', description: 'Open pages, read content, and interact with websites.' },
        computer_use: { label: 'Computer Use', action: 'Enable desktop actions', title: 'Desktop actions enabled', description: 'View and operate authorized local applications.' },
        mcp: { label: 'MCP', action: 'Connect MCP', title: 'MCP tools connected', description: 'Use MCP services connected by the current client.' },
        rive: { label: 'Rive', action: 'Enable Rive workflows', title: 'Rive workflows enabled', description: 'Run durable multi-agent workflows.' },
        agent: { label: 'Agent', action: 'Enable subagents', title: 'Subagent collaboration enabled', description: 'Delegate, track, and summarize tasks in parallel.' },
        settings: { label: 'Settings', action: 'Enable settings tools', title: 'Settings tools enabled', description: 'Read or update settings owned by the current client.' },
      },
    },
    permissionDenied: 'User denied the permission request',
    result: {
      hiddenLines: (n) => `… ${n} ${n === 1 ? 'line' : 'lines'} hidden`, ptyFailed: 'Background terminal interaction failed', queued: 'Entered', notQueued: 'Not entered', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}: ${preview}` : `${action}: ${preview}… · ${bytes} bytes total`, byteCount: (action, bytes) => `${action} ${bytes} bytes`, resizeNotApplied: (size) => `Not resized to ${size}`, resized: (size) => `Resized to ${size}`, sizeUnchanged: (size) => `Size already ${size}`, ptyCompleted: 'Background terminal interaction completed', terminalUnavailable: 'Terminal output unavailable', noTerminalFrame: '(No terminal frame available)', noOutputYet: '(No output yet)', noOutput: '(No output)', exitCode: (code) => `exit code ${code}`, managedBySource: 'Managed by the source task', sourceUnavailable: 'Source task unavailable', running: 'Running', success: 'Succeeded', failed: 'Failed', timedOut: 'Timed out', cancelled: 'Cancelled', disconnected: 'Disconnected', terminalTruncated: 'Terminal output truncated', terminalRedacted: 'Terminal output redacted', streamHidden: (stream, n) => `… ${n} ${stream} ${n === 1 ? 'line' : 'lines'} hidden`, streamsTruncated: (limit) => `Output truncated · showing the first ${limit} lines of each stream`, outputTruncated: 'Output truncated', outputRedacted: 'Output redacted',
      backgroundStatus: { running: 'Running in background', completed: 'Background task completed', failed: 'Background task failed', timed_out: 'Background task timed out', cancelled: 'Background task cancelled', orphaned: 'Background task disconnected' }, backgroundUnknown: (status) => `Background · ${status}`,
      workflow: { action: 'Action', status: 'Status', error: 'Error', nodes: 'Node summary', diagnostics: 'Diagnostic excerpts' }, webNoResults: 'No results', webResults: (n) => `${n} ${n === 1 ? 'result' : 'results'}`, credentialSource: { env: 'Environment variable', settings: 'Locally saved key', missing: 'Not configured', unknown: 'Unknown source' }, webFailure: 'Search failed', webSearch: 'Web search', webGuidance: { env: 'Check TAVILY_API_KEY / MAKA_TAVILY_API_KEY and restart.', settings: 'Update the Tavily key in Settings · Web search.', rate_limited: 'Tavily is rate-limiting requests. Try again later or use another credential.', not_configured: 'Configure web search before retrying.', timed_out: 'The request timed out. Try again later.', privacy_mode: 'Web search is disabled in privacy mode.', unknown: 'Check the network connection or try again later.' },
      workflowCompleted: 'Rive workflow completed',
      workflowFailed: 'Rive workflow failed',
      fileWritten: (bytes, path) => `Wrote ${bytes} bytes to ${path}`,
    },
    agent: {
      subagentStatus: { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', running: 'Running', waiting_for_user: 'Waiting for user input' },
      readOnly: 'Read only',
    },
  },
} satisfies UiCatalog<ToolActivityCopy>;

export function getToolActivityCopy(locale: UiLocale): ToolActivityCopy {
  return TOOL_ACTIVITY_COPY[locale];
}
