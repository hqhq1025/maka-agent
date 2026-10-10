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

import { useEffect, useMemo, useState } from 'react';
import type { ComputerUsePresentation } from '../../../../../shared/computer-use-presentation.js';
import { useWorkbarServices } from '../../services-context.js';

/** Subscribe only to the displayed task; a late read cannot replace a newer event. */
export function useComputerUsePresentation(sessionId: string | undefined, active = true) {
  const { computerUse } = useWorkbarServices();
  const subscription = useMemo(() => ({ sessionId, active, computerUse }), [sessionId, active, computerUse]);
  const [state, setState] = useState<{
    subscription?: typeof subscription;
    presentation: ComputerUsePresentation | null;
    failed: boolean;
  }>({ presentation: null, failed: false });

  useEffect(() => {
    if (!sessionId || !active || !computerUse) return;
    let disposed = false;
    let changed = false;
    let unsubscribe: () => void;
    try {
      unsubscribe = computerUse.subscribe(sessionId, (presentation) => {
        if (disposed || (presentation && presentation.sessionId !== sessionId)) return;
        changed = true;
        setState({ subscription, presentation, failed: false });
      });
    } catch {
      setState({ subscription, presentation: null, failed: true });
      return;
    }
    void Promise.resolve().then(() => disposed ? null : computerUse.read(sessionId)).then((presentation) => {
      if (disposed || changed || (presentation && presentation.sessionId !== sessionId)) return;
      setState({ subscription, presentation, failed: false });
    }, () => {
      if (!disposed && !changed) setState({ subscription, presentation: null, failed: true });
    });
    return () => { disposed = true; unsubscribe(); };
  }, [subscription, sessionId, active, computerUse]);

  const current = active && state.subscription === subscription;
  return {
    presentation: current ? state.presentation : null,
    failed: current && state.failed,
    available: computerUse !== undefined,
  };
}
