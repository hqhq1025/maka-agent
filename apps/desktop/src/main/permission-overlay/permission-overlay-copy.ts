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

/**
 * Copy for the drag-to-grant card.
 *
 * It lives in main, not the renderer, because the card is a standalone
 * overlay page with no access to the renderer's locale context — main
 * resolves the locale and ships the finished strings in the show payload.
 */

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { DragGrantPermissionId } from './permission-overlay-controller.js';

export interface PermissionOverlayCopy {
  /** Headline, e.g. "Drag Maka into the list to allow Accessibility". */
  headline(appName: string): string;
  /** The manual route, so the card is never the only way through. */
  fallback: string;
  /** Shown once the grant lands. */
  granted: string;
  dismiss: string;
  dragHint: string;
  /**
   * The in-process driver inherits host TCC state, which macOS caches.
   * Fully relaunch the host after either grant changes.
   */
  restartHint?: string;
  /** Shown instead of the drag affordance when there is no .app to drag. */
  noBundle: string;
}

type Catalog = UiCatalog<Record<DragGrantPermissionId, PermissionOverlayCopy>>;

const COPY: Catalog = {
  'zh-CN': {
    accessibility: {
      headline: (appName) => `把 ${appName} 拖到上面的列表里，即可开启「辅助功能」`,
      fallback: '也可以在系统设置里点 + 号，从「应用程序」中选择本 App。',
      granted: '辅助功能已开启',
      dismiss: '关闭',
      dragHint: '拖我',
      restartHint: '修改授权后，请完全退出并重新打开 App，让电脑操作读取新的权限。',
      noBundle: '当前不是以 .app 方式运行，无法拖拽。请在系统设置里手动添加。',
    },
    screen_recording: {
      headline: (appName) => `把 ${appName} 拖到上面的列表里，即可开启「屏幕录制」`,
      fallback: '窗口截图和图像确认需要这项权限；未授权时仍可操作控件。也可以在系统设置里点 + 号，从「应用程序」中选择本 App。',
      granted: '屏幕录制已开启',
      dismiss: '关闭',
      dragHint: '拖我',
      restartHint: '修改授权后，请完全退出并重新打开 App，让电脑操作读取新的权限。',
      noBundle: '当前不是以 .app 方式运行，无法拖拽。请在系统设置里手动添加。',
    },
  },
  'zh-TW': {
    accessibility: {
      headline: (appName) => `把 ${appName} 拖到上面的列表裡，即可開啟「輔助功能」`,
      fallback: '也可以在系統設定裡點 + 號，從「應用程式」中選擇本 App。',
      granted: '輔助功能已開啟',
      dismiss: '關閉',
      dragHint: '拖我',
      restartHint: '修改授權後，請完全結束並重新開啟 App，讓電腦操作讀取新的權限。',
      noBundle: '目前不是以 .app 方式執行，無法拖拽。請在系統設定裡手動新增。',
    },
    screen_recording: {
      headline: (appName) => `把 ${appName} 拖到上面的列表裡，即可開啟「螢幕錄製」`,
      fallback: '視窗截圖和影像確認需要這項權限；未授權時仍可操作控制項。也可以在系統設定裡點 + 號，從「應用程式」中選擇本 App。',
      granted: '螢幕錄製已開啟',
      dismiss: '關閉',
      dragHint: '拖我',
      restartHint: '修改授權後，請完全結束並重新開啟 App，讓電腦操作讀取新的權限。',
      noBundle: '目前不是以 .app 方式執行，無法拖拽。請在系統設定裡手動新增。',
    },
  },
  en: {
    accessibility: {
      headline: (appName) => `Drag ${appName} into the list above to allow Accessibility`,
      fallback: 'Or click + in System Settings and pick the app from Applications.',
      granted: 'Accessibility enabled',
      dismiss: 'Close',
      dragHint: 'Drag me',
      restartHint: 'After changing the grant, fully quit and reopen the app so computer actions use the new permission.',
      noBundle: 'Not running from a .app bundle, so there is nothing to drag. Add it manually in System Settings.',
    },
    screen_recording: {
      headline: (appName) => `Drag ${appName} into the list above to allow Screen Recording`,
      fallback: 'Window screenshots and visual verification need this permission; app controls can still be operated without it. You can also click + in System Settings and pick the app from Applications.',
      granted: 'Screen Recording enabled',
      dismiss: 'Close',
      dragHint: 'Drag me',
      restartHint: 'After changing the grant, fully quit and reopen the app so computer actions use the new permission.',
      noBundle: 'Not running from a .app bundle, so there is nothing to drag. Add it manually in System Settings.',
    },
  },
};

export function getPermissionOverlayCopy(
  locale: UiLocale,
  permission: DragGrantPermissionId,
): PermissionOverlayCopy {
  return COPY[locale][permission];
}
