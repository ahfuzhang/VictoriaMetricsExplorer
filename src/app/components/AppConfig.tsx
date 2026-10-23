import React, { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import { AppPluginMeta, PluginConfigPageProps } from '@grafana/data';
import { Alert, Button, Field, FieldSet, SecretInput, Stack } from '@grafana/ui';

import { describeError } from '../../explorer/api';

/** secureJsonData key the backend reads its service-account token from (pkg/app/app.go). */
const TOKEN_KEY = 'serviceAccountToken';

type Props = PluginConfigPageProps<AppPluginMeta>;

interface CheckResult {
  ok: boolean;
  message: string;
}

/**
 * The app's Configuration page: the service-account token the backend uses when Grafana does not
 * give the plugin a managed service account. The other settings (jsonData) are provisioned and are
 * saved back unchanged.
 */
export const AppConfig: React.FC<Props> = ({ plugin }) => {
  const meta = plugin.meta;
  const [isConfigured, setIsConfigured] = useState(Boolean(meta.secureJsonFields?.[TOKEN_KEY]));
  const [token, setToken] = useState('');
  // Set when Reset was clicked, so that saving clears the stored token.
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const value = token.trim();
      await lastValueFrom(
        getBackendSrv().fetch({
          url: `/api/plugins/${meta.id}/settings`,
          method: 'POST',
          data: {
            enabled: meta.enabled,
            pinned: meta.pinned,
            jsonData: meta.jsonData,
            // Leave the stored token alone unless it was replaced or reset.
            secureJsonData: value || cleared ? { [TOKEN_KEY]: value } : undefined,
          },
          // The health check result below reports the outcome.
          showSuccessAlert: false,
          showErrorAlert: false,
        })
      );
      if (value || cleared) {
        setIsConfigured(value !== '');
        setToken('');
        setCleared(false);
      }
      setResult(await checkHealth(meta.id));
    } catch (err) {
      setResult({ ok: false, message: `Cannot save the settings: ${describeError(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FieldSet label="Service account">
      <p>
        The Explorer reads datasources through Grafana with a service account. Grafana creates one for the plugin when
        the <code>externalServiceAccounts</code> feature toggle and <code>[auth] managed_service_accounts_enabled</code>{' '}
        are both on (organization 1 only). Otherwise, create a service account in this organization (Administration ›
        Users and access › Service accounts) with the Viewer role, which grants <code>datasources:read</code> and{' '}
        <code>datasources:query</code>, add a token to it and paste the token here. A token set here is used instead of
        the managed service account.
      </p>
      <p>
        Every Explorer user reaches the datasources this token can query, whatever their own datasource permissions. To
        limit them, list the allowed datasources in the app&apos;s <code>datasourceUids</code> setting.
      </p>
      <Field label="Service account token" description="Stored encrypted; it cannot be read back.">
        <SecretInput
          width={60}
          isConfigured={isConfigured}
          value={token}
          placeholder="glsa_…"
          onChange={(e) => setToken(e.currentTarget.value)}
          onReset={() => {
            setIsConfigured(false);
            setToken('');
            setCleared(true);
          }}
        />
      </Field>
      <Stack direction="column" gap={2} alignItems="flex-start">
        <Button onClick={save} disabled={busy} icon={busy ? 'spinner' : undefined}>
          Save &amp; test
        </Button>
        {result && (
          <Alert
            title={result.ok ? 'Service account works' : 'Service account check failed'}
            severity={result.ok ? 'success' : 'error'}
          >
            {result.message}
          </Alert>
        )}
      </Stack>
    </FieldSet>
  );
};

/** Run the backend's health check, which lists the datasources with the service account. */
async function checkHealth(pluginId: string): Promise<CheckResult> {
  try {
    const resp = await lastValueFrom(
      getBackendSrv().fetch<{ message?: string }>({
        url: `/api/plugins/${pluginId}/health`,
        method: 'GET',
        showErrorAlert: false,
      })
    );
    return { ok: true, message: resp.data?.message ?? 'OK' };
  } catch (err) {
    // An unhealthy plugin answers HTTP 400 with { status: "ERROR", message }.
    return { ok: false, message: describeError(err) };
  }
}
