import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Shared setup of the favorites end-to-end tests: a temporary Viewer, synthetic series in
// VictoriaMetrics for the last two hours, and a clean User Storage resource.

export const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3000';
export const VM_URL = process.env.VM_URL ?? 'http://localhost:8428';
export const PLUGIN_ID = 'ahfuzhang-victoriametricsexplorer-app';
export const APP_PATH = `/a/${PLUGIN_ID}`;
const ADMIN = {
  user: process.env.GRAFANA_ADMIN_USER ?? 'admin',
  password: process.env.GRAFANA_ADMIN_PASSWORD ?? 'admin',
};

export interface TestUser {
  id: number;
  uid: string;
  login: string;
  password: string;
}

export function adminHeaders(): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${ADMIN.user}:${ADMIN.password}`).toString('base64')}` };
}

export async function createViewer(request: APIRequestContext, login: string): Promise<TestUser> {
  const password = `${login}-pass-1`;
  const existing = await request.get(`${GRAFANA_URL}/api/users/lookup?loginOrEmail=${login}`, {
    headers: adminHeaders(),
  });
  if (existing.ok()) {
    await request.delete(`${GRAFANA_URL}/api/admin/users/${(await existing.json()).id}`, { headers: adminHeaders() });
  }
  const created = await request.post(`${GRAFANA_URL}/api/admin/users`, {
    headers: adminHeaders(),
    data: { name: login, login, password, OrgId: 1 },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const user = await (await request.get(`${GRAFANA_URL}/api/users/${id}`, { headers: adminHeaders() })).json();
  return { id, uid: user.uid || String(id), login, password };
}

export function resourceUrl(user: TestUser): string {
  return `${GRAFANA_URL}/apis/userstorage.grafana.app/v0alpha1/namespaces/default/user-storage/${encodeURIComponent(
    `${PLUGIN_ID}:${user.uid}`
  )}`;
}

/** The test user's favorites resource as the server holds it, or null. */
export async function readResource(
  request: APIRequestContext,
  user: TestUser
): Promise<{ resourceVersion: string; data: Record<string, string> } | null> {
  const response = await request.get(resourceUrl(user), { headers: adminHeaders() });
  if (response.status() === 404) {
    return null;
  }
  const body = await response.json();
  return { resourceVersion: body.metadata.resourceVersion, data: body.spec.data ?? {} };
}

export async function deleteViewer(request: APIRequestContext, user: TestUser): Promise<void> {
  await request.delete(resourceUrl(user), { headers: adminHeaders() });
  await request.delete(`${GRAFANA_URL}/api/admin/users/${user.id}`, { headers: adminHeaders() });
}

export const E2E_METRIC = 'vmexplorer_e2e_requests_total';
export const E2E_GAUGE = 'vmexplorer_e2e_memory_bytes';

/**
 * Write per-minute samples of two series per metric for the last two hours. Values depend only on
 * the timestamp, so seeding again (another run) writes the same value at the same time instead of
 * making the counters look like they reset.
 */
export async function seedSeries(request: APIRequestContext): Promise<void> {
  await removeSeries(request);
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const lines: string[] = [];
  for (const [instance, pod, node] of [
    ['a', 'e2e-api-7d9f8-abcde', 'e2e-node-1'],
    ['b', 'e2e-api-7d9f8-fghij', 'e2e-node-2'],
  ]) {
    const labels = { __name__: '', job: 'e2e', instance, pod, node };
    const timestamps: number[] = [];
    const counter: number[] = [];
    const gauge: number[] = [];
    for (let minute = 120; minute >= 0; minute--) {
      const timestamp = now - minute * 60_000;
      const absoluteMinute = timestamp / 60_000;
      timestamps.push(timestamp);
      counter.push(absoluteMinute * (instance === 'a' ? 60 : 30));
      gauge.push((instance === 'a' ? 200 : 300) * 1024 * 1024 + (absoluteMinute % 60) * 1024);
    }
    lines.push(JSON.stringify({ metric: { ...labels, __name__: E2E_METRIC }, values: counter, timestamps }));
    lines.push(JSON.stringify({ metric: { ...labels, __name__: E2E_GAUGE }, values: gauge, timestamps }));
  }
  const response = await request.post(`${VM_URL}/api/v1/import`, { data: lines.join('\n') });
  expect(response.ok()).toBeTruthy();
  // Make the new samples searchable right away.
  await request.get(`${VM_URL}/internal/force_flush`);
}

export async function removeSeries(request: APIRequestContext): Promise<void> {
  await request.post(`${VM_URL}/api/v1/admin/tsdb/delete_series`, {
    form: { 'match[]': '{__name__=~"vmexplorer_e2e_.*"}' },
  });
}

/** A fresh browser context signed in as user: no cookies, no localStorage from earlier contexts. */
export async function signedIn(browser: Browser, user: TestUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: GRAFANA_URL });
  const login = await context.request.post(`${GRAFANA_URL}/login`, {
    data: { user: user.login, password: user.password },
  });
  expect(login.ok()).toBeTruthy();
  const page = await context.newPage();
  return { context, page };
}

/** Open the app and wait until the favorites menu has loaded from the server. */
export async function openApp(page: Page): Promise<void> {
  await page.goto(APP_PATH);
  await expect(page.getByRole('button', { name: /My favorites/ })).toBeVisible();
  await expect(page.getByText('Loading favorites…')).toHaveCount(0);
}

/** Browse to the e2e metric through By Name → All metrics and select it. */
export async function selectMetric(page: Page, metric: string): Promise<void> {
  await page.getByRole('button', { name: /By Name/ }).click();
  await page.getByRole('treeitem', { name: /All metrics/ }).click();
  await page.getByLabel('Search metric names').fill(metric);
  await page.getByText(metric, { exact: true }).first().click();
}

/** Every key this feature may have left in the page's browser storage. */
export async function browserStorageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const keys: string[] = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index++) {
        keys.push(storage.key(index)!);
      }
    }
    return keys;
  });
}
