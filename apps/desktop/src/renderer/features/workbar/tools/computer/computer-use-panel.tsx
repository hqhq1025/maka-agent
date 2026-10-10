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

import { useState } from 'react';
import type { Ref } from 'react';
import { Button, Text } from '@astryxdesign/core';
import { useUiLocale } from '@maka/ui';
import { Monitor, ICON_SIZE } from '@maka/ui/icons';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComputerUsePresentation } from '../../../../../shared/computer-use-presentation.js';
import type { ComputerUsePreviewStatus } from '../../../../../shared/computer-use-preview.js';
import { useWorkbarServices } from '../../services-context.js';
import { computerUseAction, computerUseCopy } from './computer-use-copy.js';
import { useComputerUsePresentation } from './use-computer-use-presentation.js';
import { useComputerUsePreview } from './use-computer-use-preview.js';

export function ComputerUsePanel(props: { sessionId: string; active: boolean }) {
  const { computerUse } = useWorkbarServices();
  const result = useComputerUsePresentation(props.sessionId, props.active);
  const previewPermitted = result.presentation?.state === 'running' || result.presentation?.state === 'settled';
  const preview = useComputerUsePreview(props.sessionId, props.active, previewPermitted);
  const [pendingSession, setPendingSession] = useState<string>();
  const [failedSession, setFailedSession] = useState<string>();
  const stop = async () => {
    if (!computerUse || pendingSession === props.sessionId) return;
    const sessionId = props.sessionId;
    setPendingSession(sessionId);
    setFailedSession(undefined);
    try { await computerUse.stop(sessionId); }
    catch { setFailedSession(sessionId); }
    finally { setPendingSession((current) => current === sessionId ? undefined : current); }
  };
  return <ComputerUsePanelView
    presentation={result.presentation}
    unavailable={!result.available || result.failed}
    locale={useUiLocale()}
    stopPending={pendingSession === props.sessionId}
    stopFailed={failedSession === props.sessionId}
    onStop={() => void stop()}
    preview={preview.status}
    previewAvailable={preview.available && previewPermitted}
    previewSlotRef={preview.slotRef}
    onStartPreview={preview.start}
    onStopPreview={preview.stop}
  />;
}

export function ComputerUsePanelView(props: {
  presentation: ComputerUsePresentation | null;
  locale: UiLocale;
  unavailable?: boolean;
  stopPending?: boolean;
  stopFailed?: boolean;
  onStop?(): void;
  preview?: ComputerUsePreviewStatus;
  previewAvailable?: boolean;
  previewSlotRef?: Ref<HTMLDivElement>;
  onStartPreview?(): void;
  onStopPreview?(): void;
}) {
  const copy = computerUseCopy(props.locale);
  const state = props.presentation;
  const frame = state?.frame;
  const previewVisible = props.preview?.state === 'starting' || props.preview?.state === 'live' || props.preview?.state === 'waiting';
  const previewLive = props.preview?.state === 'live';
  const previewCopy = computerUsePreviewCopy(props.preview, props.locale);
  const canStop = state && state.state !== 'stopped' && state.state !== 'completed' && props.onStop;
  return (
    <section className="maka-computer-panel" aria-label={copy.computer}>
      {state ? <>
        <div className="maka-computer-panel-heading">
          <div className="maka-computer-panel-status" role="status">
            <Text type="label">{state.appName || copy.computer}</Text>
            <Text type="supporting" color="secondary">{
              state.state === 'stopping' || state.state === 'stopped' || state.state === 'completed'
                ? copy[state.state] : computerUseAction(state, props.locale)
            }</Text>
          </div>
          {canStop ? <Button variant="secondary" label={props.stopPending ? copy.stopping : copy.stop}
            isDisabled={props.stopPending || state.state === 'stopping'} onClick={props.onStop} /> : null}
        </div>
        {state.state === 'stopping' ? <Text type="supporting" role="status">{copy.stoppingDetail}</Text> : null}
      </> : <div className="maka-computer-empty">
        <Monitor size={ICON_SIZE.control} aria-hidden="true" />
        <Text type="label">{props.unavailable ? copy.unavailable : copy.empty}</Text>
        <Text type="supporting" color="secondary">{props.unavailable ? copy.unavailableDetail : copy.emptyDetail}</Text>
      </div>}
      {props.stopFailed ? <Text type="supporting" role="alert">{copy.stopFailed}</Text> : null}
      {state ? <>
        {props.previewAvailable ? <div className="maka-computer-preview-controls">
          <div className="maka-computer-preview-copy" role="status">
            <Text type="supporting" weight="medium">{previewCopy.label}</Text>
            <Text type="supporting" color="secondary">{previewCopy.detail}</Text>
          </div>
          <Button variant="secondary" label={previewVisible ? copy.previewStop : props.preview ? copy.previewRetry : copy.previewStart}
            onClick={previewVisible ? props.onStopPreview : props.onStartPreview} />
        </div> : null}
        <div ref={props.previewSlotRef} className="maka-computer-preview-slot"
          data-live={previewLive || undefined} aria-label={copy.preview}
          style={{ aspectRatio: frame ? `${frame.widthPx} / ${frame.heightPx}` : '16 / 10' }}>
          {!previewLive && frame ? <img src={`data:${frame.mimeType};base64,${frame.base64}`} alt={copy.frameAlt}
            width={frame.widthPx} height={frame.heightPx} draggable={false} /> : !previewLive ? <div className="maka-computer-empty maka-computer-no-frame">
            <Monitor size={ICON_SIZE.control} aria-hidden="true" />
            <Text type="label">{copy.noFrame}</Text>
            <Text type="supporting" color="secondary">{copy.noFrameDetail}</Text>
          </div> : null}
        </div>
      </> : null}
      {frame && !previewLive ? <div className="maka-computer-frame-caption">
          <Text type="supporting" color="secondary">{copy.lastFrame}</Text>
          <time dateTime={new Date(frame.capturedAt).toISOString()}>
            <Text type="supporting" color="secondary">{new Date(frame.capturedAt).toLocaleTimeString(props.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>
          </time>
      </div> : null}
    </section>
  );
}

function computerUsePreviewCopy(preview: ComputerUsePreviewStatus | undefined, locale: UiLocale) {
  const copy = computerUseCopy(locale);
  if (!preview) return { label: copy.previewIdle, detail: copy.previewIdleDetail };
  if (preview.state === 'live') return { label: copy.previewLive, detail: copy.previewIdleDetail };
  if (preview.state === 'starting') return { label: copy.previewStarting, detail: copy.previewIdleDetail };
  if (preview.state === 'waiting') return { label: copy.previewStarting, detail: copy.previewChanged };
  if (preview.state === 'stopped') return { label: copy.previewStopped, detail: preview.reason === 'hidden' ? copy.previewHidden : copy.previewIdleDetail };
  const detail = preview.reason === 'permission_denied' ? copy.previewPermission
    : preview.reason === 'unsupported_platform' ? copy.previewUnsupported
      : preview.reason === 'target_changed' ? copy.previewChanged
        : preview.reason === 'locked' ? copy.previewLocked
          : preview.reason === 'target_unavailable' || preview.reason === 'identity_unavailable' ? copy.previewTarget
            : copy.previewFailed;
  return { label: copy.previewUnavailable, detail };
}
