import { expect, test } from '@playwright/test';

import { createViewer, deleteViewer, openApp, signedIn, VM_URL, type TestUser } from './fixtures';

let user: TestUser;
const pod = 'vmx-config-test-7d4f8c9b7-k8pnx';
const nodes = ['vmx-config-node-a', 'vmx-config-worker-b'];

test.beforeAll(async ({ request }) => {
  user = await createViewer(request, 'vmexplorer-config-e2e');
  const names = [
    'process_cpu_seconds_total',
    'process_num_threads',
    'system_runtime_threadpool_thread_count',
    'process_start_time_seconds',
    'process_working_set_bytes',
    'system_runtime_gen_0_size',
    'system_runtime_gen_1_size',
    'system_runtime_gen_2_size',
    'system_runtime_loh_size',
    'system_runtime_poh_size',
    'container_cpu_system_seconds_total',
    'container_cpu_user_seconds_total',
  ];
  const now = Math.floor(Date.now() / 60000) * 60000;
  const lines = names.map((name, index) => {
    const timestamps = Array.from({ length: 61 }, (_, n) => now - (60 - n) * 60000);
    const values = timestamps.map((t) =>
      name === 'process_start_time_seconds'
        ? now / 1000 - 7200
        : name.includes('cpu_')
          ? (t / 1000) * 0.2
          : name.includes('working_set')
            ? 100000000
            : name.includes('size')
              ? 1000000 + index
              : 5
    );
    return JSON.stringify({
      metric: { __name__: name, pod, job: 'vmx-config-test', namespace: 'config-test', image: 'example' },
      values,
      timestamps,
    });
  });
  lines.push(
    JSON.stringify({
      metric: { __name__: 'kube_pod_container_resource_limits', pod, job: 'vmx-config-test', resource: 'cpu' },
      values: [2],
      timestamps: [now],
    })
  );
  for (const node of nodes) {
    lines.push(
      JSON.stringify({
        metric: { __name__: 'vmx_config_node_info', job: 'vmx-config-test', node },
        values: [1],
        timestamps: [now],
      })
    );
  }
  expect((await request.post(`${VM_URL}/api/v1/import`, { data: lines.join('\n') })).ok()).toBeTruthy();
  await request.get(`${VM_URL}/internal/force_flush`);
});

test.afterAll(async ({ request }) => {
  await deleteViewer(request, user);
  await request.post(`${VM_URL}/api/v1/admin/tsdb/delete_series`, { form: { 'match[]': '{job="vmx-config-test"}' } });
});

test('By Pod filters pod prefixes with a regular expression', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  try {
    await openApp(page);
    const filter = page.getByLabel('Filter pod prefixes by regular expression');
    await expect(filter).toHaveCount(0);
    await page.getByRole('button', { name: /By Node/ }).click();
    await expect(filter).toHaveCount(0);
    await page.getByRole('button', { name: /By Pod/ }).click();
    await expect(filter).toBeVisible();
    const leaf = page.getByRole('treeitem', { name: /vmx-config-test/ });
    await expect(leaf).toBeVisible();

    await filter.fill('^VMX-CONFIG-t');
    await expect(leaf).toBeVisible();
    await filter.fill('^no-such-prefix$');
    await expect(leaf).toHaveCount(0);
    await expect(page.getByText('No pod prefix matches “^no-such-prefix$”.')).toBeVisible();
    await filter.fill('vmx-[');
    await expect(page.getByText('Invalid regular expression')).toBeVisible();
    await expect(leaf).toBeVisible();
    await filter.fill('');
    await expect(leaf).toBeVisible();
  } finally {
    await context.close();
  }
});

test('By Node filters nodes with a regular expression', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  try {
    await openApp(page);
    const filter = page.getByLabel('Filter nodes by regular expression');
    await expect(filter).toHaveCount(0);
    await page.getByRole('button', { name: /By Pod/ }).click();
    await expect(filter).toHaveCount(0);
    await page.getByRole('button', { name: /By Node/ }).click();
    await expect(filter).toBeVisible();
    const nodeA = page.getByRole('treeitem', { name: nodes[0] });
    const workerB = page.getByRole('treeitem', { name: nodes[1] });
    await expect(nodeA).toBeVisible();
    await expect(workerB).toBeVisible();

    await filter.fill('^VMX-CONFIG-worker');
    await expect(workerB).toBeVisible();
    await expect(nodeA).toHaveCount(0);
    await filter.fill('node-(a|z)$');
    await expect(nodeA).toBeVisible();
    await expect(workerB).toHaveCount(0);
    await filter.fill('^no-such-node$');
    await expect(page.getByText('No node matches “^no-such-node$”.')).toBeVisible();
    await filter.fill('vmx-(');
    await expect(page.getByText('Invalid regular expression')).toBeVisible();
    await expect(nodeA).toBeVisible();
    await expect(workerB).toBeVisible();

    await nodeA.click();
    await expect(page.getByRole('region', { name: 'Metric names', exact: true })).toContainText('vmx_config_node_info');
  } finally {
    await context.close();
  }
});

test('By Name filters metric prefixes with a regular expression', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  try {
    await openApp(page);
    const filter = page.getByLabel('Filter metric prefixes by regular expression');
    await page.getByRole('button', { name: /By Pod/ }).click();
    await page.getByRole('button', { name: /By Node/ }).click();
    await expect(filter).toHaveCount(0);
    await page.getByRole('button', { name: /By Name/ }).click();
    await expect(filter).toBeVisible();
    const all = page.getByRole('treeitem', { name: /^All metrics/ });
    const processGroup = page.getByRole('treeitem', { name: /^process\b/ });
    const systemGroup = page.getByRole('treeitem', { name: /^system\b/ });
    await expect(processGroup).toBeVisible();
    await expect(systemGroup).toBeVisible();

    await filter.fill('^PROC');
    await expect(processGroup).toBeVisible();
    await expect(systemGroup).toHaveCount(0);
    await expect(all).toBeVisible();
    await filter.fill('^(sys|kube)');
    await expect(systemGroup).toBeVisible();
    await expect(processGroup).toHaveCount(0);
    await filter.fill('^no-such-prefix$');
    await expect(page.getByText('No metric prefix matches “^no-such-prefix$”.')).toBeVisible();
    await expect(all).toBeVisible();
    await filter.fill('proc(');
    await expect(page.getByText('Invalid regular expression')).toBeVisible();
    await expect(processGroup).toBeVisible();
    await expect(systemGroup).toBeVisible();

    await filter.fill('^process$');
    await processGroup.click();
    await expect(page.getByRole('region', { name: 'Metric names', exact: true })).toContainText('process_num_threads');
  } finally {
    await context.close();
  }
});

test('Metric name search takes a regular expression', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  try {
    await openApp(page);
    await page.getByRole('button', { name: /By Pod/ }).click();
    await page.getByRole('treeitem', { name: /vmx-config-test/ }).click();
    const list = page.getByRole('region', { name: 'Metric names', exact: true });
    const search = page.getByLabel('Search metric names');
    const metric = (name: string) => list.getByRole('button', { name: new RegExp(`^${name}\\b`) });

    await search.fill('^SYSTEM_RUNTIME_GEN_[01]_size$');
    await expect(metric('system_runtime_gen_0_size')).toBeVisible();
    await expect(metric('system_runtime_gen_1_size')).toBeVisible();
    await expect(metric('system_runtime_gen_2_size')).toHaveCount(0);
    await expect(metric('process_num_threads')).toHaveCount(0);

    await search.fill('process_(num|start)_');
    await expect(metric('process_num_threads')).toBeVisible();
    await expect(metric('process_start_time_seconds')).toBeVisible();
    await expect(metric('process_cpu_seconds_total')).toHaveCount(0);

    await search.fill('system_runtime_[');
    await expect(list.getByRole('alert')).toHaveText('Invalid regular expression: missing closing ]: `[`');
    await expect(list.getByText('Failed to load metrics')).toHaveCount(0);

    await search.fill('working_set');
    await expect(metric('process_working_set_bytes')).toBeVisible();
    await expect(list.getByRole('alert')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('By Pod exposes Important Metrics and renders YAML line, dual axis, stacked, stat and donut panels', async ({
  browser,
}, testInfo) => {
  const { context, page } = await signedIn(browser, user);
  try {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openApp(page);
    await page.getByRole('button', { name: /By Pod/ }).click();
    await expect(page.getByRole('link', { name: 'Important Metrics' })).toBeVisible();
    await page.getByRole('link', { name: 'Important Metrics' }).click();
    await expect(
      page.getByRole('region', { name: 'Important Metrics', exact: true }).getByText('All pods', { exact: true })
    ).toBeVisible();
    await expect(page.getByRole('article', { name: 'process_cpu_seconds_total / s', exact: true })).toBeVisible();
    await page.getByRole('treeitem', { name: /vmx-config-test/ }).click();
    await page.getByRole('link', { name: 'Important Metrics' }).click();
    const charts = page.getByRole('region', { name: 'Important Metrics', exact: true });
    const cpu = charts.getByRole('article', { name: 'process_cpu_seconds_total / s', exact: true });
    await expect(cpu).toBeVisible();
    await expect(cpu.locator('canvas').first()).toBeVisible({ timeout: 30000 });
    const donut = charts.getByRole('article', { name: 'Memory type proportion', exact: true });
    await donut.scrollIntoViewIfNeeded();
    await expect(donut.locator('canvas, svg').first()).toBeVisible({ timeout: 30000 });
    const stat = charts.getByRole('article', { name: 'process_start_time', exact: true });
    await stat.scrollIntoViewIfNeeded();
    await expect(stat).not.toContainText('Loading chart', { timeout: 30000 });
    await expect(stat).not.toContainText('No data');
    const stack = charts.getByRole('article', { name: 'CPU time', exact: true });
    await stack.scrollIntoViewIfNeeded();
    await expect(stack.locator('canvas').first()).toBeVisible({ timeout: 30000 });
    await stack.screenshot({ path: testInfo.outputPath('configured-stacked.png') });
    await cpu.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('important-metrics.png') });
    await expect(charts.getByText('Query failed', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.getByLabel('Search metric names').fill('process_cpu_seconds_total');
    await page
      .getByRole('region', { name: 'Metric names', exact: true })
      .getByRole('button', { name: /process_cpu_seconds_total/ })
      .click();
    await expect(page.getByRole('region', { name: 'Label filters', exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
