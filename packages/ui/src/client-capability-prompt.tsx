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

import { Button } from '@astryxdesign/core';
import type { ClientCapabilityRequestEvent } from '@maka/core/events';
import { useEffect, useId, useRef, useState } from 'react';
import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';
import { useMountedRef } from './use-mounted-ref.js';

export interface ClientCapabilityPromptProps {
  request: ClientCapabilityRequestEvent;
  onRespond(response: { requestId: string; decision: 'allow' | 'deny' }): void | Promise<void>;
  /** Shown only when the surrounding chat routes typed replies to this request. */
  textResponseAvailable?: boolean;
}

export function ClientCapabilityPrompt({
  request,
  onRespond,
  textResponseAvailable,
}: ClientCapabilityPromptProps) {
  const copy = getConversationCopy(useUiLocale()).clientCapability;
  const foreground = request.capability === 'computer_use'
    && request.scope.kind === 'computer_use_foreground';
  const titleId = useId();
  const [responsePending, setResponsePending] = useState(false);
  const responsePendingRef = useRef(false);
  const activeRequestIdRef = useRef(request.requestId);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    activeRequestIdRef.current = request.requestId;
    responsePendingRef.current = false;
    setResponsePending(false);
    const frame = window.requestAnimationFrame(() => rejectButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [request.requestId]);

  async function respond(decision: 'allow' | 'deny'): Promise<void> {
    if (responsePendingRef.current) return;
    const requestId = request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      await onRespond({ requestId, decision });
    } finally {
      if (activeRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (mountedRef.current) setResponsePending(false);
      }
    }
  }

  return (
    <section
      className="maka-composer-interaction maka-sandbox-boundary-prompt composer"
      aria-labelledby={titleId}
    >
      <div className="maka-composer-interaction-inner maka-sandbox-boundary-prompt-inner">
        <div className="maka-sandbox-boundary-copy">
          <h2 id={titleId}>{foreground ? copy.foregroundTitle : copy.title}</h2>
          <p>{clientCapabilityLabel(request, copy)}</p>
          <p>{foreground ? copy.foregroundNotice : copy.sessionNotice}</p>
          {textResponseAvailable && request.capability === 'computer_use' && <p>{copy.textResponseHint}</p>}
        </div>
        <div className="maka-sandbox-boundary-actions">
          <Button
            ref={rejectButtonRef}
            variant="secondary"
            isDisabled={responsePending}
            onClick={() => void respond('deny')}
            label={foreground ? copy.keepBackground : copy.reject}
          />
          <Button
            variant="primary"
            isDisabled={responsePending}
            onClick={() => void respond('allow')}
            label={foreground ? copy.allowForeground : copy.allowSession}
          />
        </div>
      </div>
    </section>
  );
}

function clientCapabilityLabel(
  request: ClientCapabilityRequestEvent,
  copy: ReturnType<typeof getConversationCopy>['clientCapability'],
): string {
  switch (request.capability) {
    case 'browser':
      if (request.scope.kind !== 'browser_origin') break;
      return copy.browser(request.scope.origin);
    case 'computer_use':
      if (request.scope.kind === 'computer_use_foreground') return copy.computerUseForeground;
      if (request.scope.kind === 'capability') return copy.computerUse;
      break;
    case 'desktop_mcp':
    case 'mcp':
      if (request.scope.kind !== 'mcp_tool') break;
      return copy.desktopMcp(request.scope.serverId, request.scope.toolName);
  }
  throw new Error('Client Capability request has an invalid scope');
}
