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

import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@astryxdesign/core';
import type { ComputerUseForegroundPolicy } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import { Selector, useMountedRef } from '@maka/ui';
import { SettingsRow, SettingsSection } from '../../application/contracts/settings-presentation/settings-section.js';
import { useActionGuard } from '../../application/contracts/settings-presentation/use-action-guard.js';
import { getPermissionCenterCopy } from '../../locales/permission-center-copy.js';

export interface ComputerUseSettingsService {
  read(): Promise<ComputerUseForegroundPolicy>;
  update(policy: ComputerUseForegroundPolicy): Promise<ComputerUseForegroundPolicy>;
  subscribeChanges(handler: () => void): () => void;
}

export function ComputerUseForegroundSettings({ services, locale, describeError }: {
  services: ComputerUseSettingsService;
  locale: UiLocale;
  describeError(error: unknown, locale: UiLocale): string;
}) {
  const copy = getPermissionCenterCopy(locale);
  const [policy, setPolicy] = useState<ComputerUseForegroundPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const actionGuard = useActionGuard<string>();
  const mountedRef = useMountedRef();

  useEffect(() => {
    let active = true;
    const read = async () => {
      const request = ++generation.current;
      try {
        const value = await services.read();
        if (!active || generation.current !== request) return;
        setPolicy(value);
        setError(null);
      } catch (cause) {
        if (!active || generation.current !== request) return;
        setError(describeError(cause, locale));
      }
    };
    const unsubscribe = services.subscribeChanges(() => void read());
    void read();
    return () => {
      active = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [services, describeError, locale, retry]);

  async function update(value: string) {
    if (value !== 'never' && value !== 'ask' && value !== 'allow') return;
    if (value === policy || !actionGuard.begin('foreground-policy')) return;
    const request = ++generation.current;
    setPending(true);
    try {
      const confirmed = await services.update(value);
      if (!mountedRef.current || generation.current !== request) return;
      setPolicy(confirmed);
      setError(null);
    } catch (cause) {
      if (mountedRef.current && generation.current === request) {
        setError(describeError(cause, locale));
      }
    } finally {
      actionGuard.finish();
      if (mountedRef.current) setPending(false);
    }
  }

  return (
    <SettingsSection title={copy.computerUseSection}>
      <SettingsRow
        label={copy.foregroundPolicy}
        description={copy.foregroundPolicyHelp}
        end={(
          <Selector
            value={policy ?? undefined}
            label={copy.foregroundPolicy}
            isLabelHidden
            options={(['never', 'ask', 'allow'] as const).map((value) => ({ value, label: copy.foregroundPolicyOptions[value] }))}
            isDisabled={policy === null || pending}
            placement="below"
            onChange={(value) => void update(value)}
          />
        )}
      />
      {error ? (
        <Banner
          status="error"
          role="alert"
          title={copy.foregroundPolicyFailed}
          description={error}
          endContent={<Button variant="secondary" label={copy.readAgain} onClick={() => setRetry((value) => value + 1)} />}
        />
      ) : null}
    </SettingsSection>
  );
}
