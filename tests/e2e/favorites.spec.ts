import { expect, test, type Page } from '@playwright/test';

import { MENU_KEY, contentKey, decodeContent, decodeTree, encodeContent } from '../../src/explorer/favorites/codec';
import {
  E2E_GAUGE,
  E2E_METRIC,
  browserStorageKeys,
  createViewer,
  deleteViewer,
  openApp,
  readResource,
  removeSeries,
  resourceUrl,
  seedSeries,
  selectMetric,
  signedIn,
  type TestUser,
} from './fixtures';

// The favorites flows of docs/plan_v3.md §13.2 against a real Grafana. The tests share one
// temporary Viewer and build on each other, so they run in order.
test.describe.configure({ mode: 'serial' });

let user: TestUser;

test.beforeAll(async ({ request }) => {
  await seedSeries(request);
  user = await createViewer(request, 'vmexplorer-e2e');
});

test.afterAll(async ({ request }) => {
  await deleteViewer(request, user);
  await removeSeries(request);
});

/** The menu as the server stores it: "id:name" entries, nested arrays for folders. */
async function serverMenu(request: Parameters<typeof readResource>[0]): Promise<unknown[]> {
  const resource = await readResource(request, user);
  if (!resource?.data[MENU_KEY]) {
    return [];
  }
  const tree = await decodeTree(resource.data[MENU_KEY]);
  const walk = (nodes: typeof tree.children): unknown[] =>
    nodes.map((node) =>
      node.kind === 1 ? { [`${node.id}:${node.name}`]: walk(node.children) } : `${node.id}:${node.name}`
    );
  return walk(tree.children);
}

async function serverQueries(request: Parameters<typeof readResource>[0], id: number): Promise<string[]> {
  const resource = await readResource(request, user);
  const value = resource?.data[contentKey(BigInt(id))];
  if (!value) {
    return [];
  }
  return (await decodeContent(value)).queries.map((query) => `${query.name}:${query.statements.length}`);
}

/** Point every statement of a favorite at another datasource, on the server, as the test user. */
async function setSavedDatasource(request: Parameters<typeof readResource>[0], id: number, uid: string) {
  const resource = (await readResource(request, user))!;
  const key = contentKey(BigInt(id));
  const content = await decodeContent(resource.data[key]);
  for (const statement of content.queries.flatMap((query) => query.statements)) {
    statement.datasourceUid = uid;
    statement.datasourceNameHint = uid;
  }
  const response = await request.patch(resourceUrl(user), {
    headers: {
      Authorization: `Basic ${Buffer.from(`${user.login}:${user.password}`).toString('base64')}`,
      'Content-Type': 'application/merge-patch+json',
    },
    data: {
      metadata: { resourceVersion: resource.resourceVersion },
      spec: { data: { [key]: await encodeContent(content) } },
    },
  });
  expect(response.ok()).toBeTruthy();
}

const menuTree = (page: Page) => page.getByRole('tree', { name: 'My favorites' });

async function saveChart(page: Page, favoriteName: string, options: { existing?: boolean } = {}) {
  await page.getByRole('button', { name: 'Save this chart to favorites' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save to favorites' });
  await expect(dialog.getByText('Loading favorites…')).toHaveCount(0);
  if (options.existing) {
    // Picking a favorite drops a new name typed before it.
    await dialog.getByLabel('New favorite name').fill('Not this one');
    await dialog.getByRole('tree', { name: 'Choose where to save' }).getByText(favoriteName, { exact: true }).click();
    await expect(dialog.getByLabel('New favorite name')).toHaveValue('');
  } else {
    await dialog.getByLabel('New favorite name').fill(favoriteName);
  }
  return dialog;
}

test('saves the chart on screen into a new favorite, on the server only', async ({ browser, request }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await expect(page.getByText('No favorites yet. Use ★ Favorite on a chart to save one here.')).toBeVisible();
  await selectMetric(page, E2E_METRIC);

  const dialog = await saveChart(page, 'E2E requests');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(E2E_METRIC);
  await expect(dialog.getByText('Source: By Name · All metrics')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Saved to favorites on the Grafana server.')).toBeVisible();
  await expect(menuTree(page).getByText('E2E requests', { exact: true })).toBeVisible();

  expect(await serverMenu(request)).toEqual(['1:E2E requests']);
  expect(await serverQueries(request, 1)).toEqual([`${E2E_METRIC}:1`]);
  // Nothing about favorites is kept in the browser.
  expect((await browserStorageKeys(page)).filter((key) => /favorite/i.test(key))).toEqual([]);
  await context.close();
});

test('opens a favorite in saved mode and runs its statements', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await menuTree(page).getByText('E2E requests', { exact: true }).click();

  await expect(page.getByRole('list', { name: 'Saved queries' })).toContainText(E2E_METRIC);
  const query = page.getByRole('region', { name: `Saved query ${E2E_METRIC}` });
  const options = query.getByRole('complementary', { name: 'Statement 1 options' });
  await expect(options.getByText('By Name · All metrics')).toBeVisible();
  const chart = query.getByRole('region', { name: 'Statement 1 chart' });
  await expect(chart.locator('code')).toContainText(`(rate({__name__="${E2E_METRIC}"}`);
  await expect(chart.getByText(/^step \d+[smh]$/)).toBeVisible();
  await expect(chart.getByText('1 series')).toBeVisible();
  // Per minute runs the expression with increase() instead, for this view only.
  await expect(options.getByRole('button', { name: 'per second', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await options.getByRole('button', { name: 'per minute' }).click();
  await expect(options.getByRole('button', { name: 'per minute' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.locator('code')).toContainText(`(increase({__name__="${E2E_METRIC}"}`);
  await expect(chart.getByText('1 series')).toBeVisible();
  await options.getByRole('button', { name: 'Reset' }).click();
  await expect(chart.locator('code')).toContainText(`(rate({__name__="${E2E_METRIC}"}`);
  // The toolbar's Step and time range apply: the window saved with the chart follows the Step.
  await page.locator('label', { hasText: 'Step' }).click();
  await page.getByRole('option', { name: '5 minutes' }).first().click();
  await expect(chart.locator('code')).toHaveText(`sum by () (rate({__name__="${E2E_METRIC}"}[5m]))`);
  await expect(chart.getByText('step 5m', { exact: true })).toBeVisible();
  await expect(options.getByText('5m, the Step')).toBeVisible();
  const rangeBadge = chart.getByTitle('Range after aligning to the step');
  const lastHour = await rangeBadge.innerText();
  await page.getByRole('button', { name: 'Last 1 hour' }).click();
  await page.getByRole('dialog', { name: 'Select time range' }).getByRole('radio', { name: '6h' }).click();
  await expect(page.getByRole('button', { name: 'Last 6 hours' })).toBeVisible();
  await expect(rangeBadge).not.toHaveText(lastHour);
  await expect(chart.getByText('1 series')).toBeVisible();
  // Saved queries run on the toolbar's datasource, so it stays selectable.
  await expect(page.getByRole('combobox', { name: /^Datasource/ })).toHaveCount(1);

  await page.getByRole('button', { name: 'Back to browsing' }).click();
  await expect(page.getByLabel('Search metric names')).toBeVisible();
  await context.close();
});

test('runs a favorite on the toolbar datasource, not the one it was saved with', async ({ browser, request }) => {
  await setSavedDatasource(request, 1, 'deleted-datasource');
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await menuTree(page).getByText('E2E requests', { exact: true }).click();
  const chart = page.getByRole('region', { name: 'Statement 1 chart' });
  await expect(chart.getByText('VictoriaMetrics Local', { exact: true })).toBeVisible();
  await expect(chart.getByText('1 series')).toBeVisible();
  await context.close();
  // Later tests fall back to the saved datasource when none can be listed.
  await setSavedDatasource(request, 1, 'victoriametrics-explorer-local');
});

test('restores favorites from the server in a fresh browser context', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  expect(await browserStorageKeys(page).catch(() => [])).toEqual([]);
  await openApp(page);
  await expect(menuTree(page).getByText('E2E requests', { exact: true })).toBeVisible();
  await context.close();
});

test('two windows saving at once keep both favorites under different ids', async ({ browser, request }) => {
  const a = await signedIn(browser, user);
  const b = await signedIn(browser, user);
  for (const { page } of [a, b]) {
    await openApp(page);
    await selectMetric(page, E2E_METRIC);
  }
  // Both dialogs read the same server version before either saves.
  const dialogA = await saveChart(a.page, 'Window A');
  const dialogB = await saveChart(b.page, 'Window B');
  await dialogA.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialogA).toBeHidden();
  await dialogB.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialogB).toBeHidden();

  // B was rejected (409), replayed on A's menu and got the next id. Its position is "after the
  // entry it followed when its dialog opened" (§3.3), so it sits right after E2E requests.
  expect(await serverMenu(request)).toEqual(['1:E2E requests', '3:Window B', '2:Window A']);
  expect(await serverQueries(request, 2)).toEqual([`${E2E_METRIC}:1`]);
  expect(await serverQueries(request, 3)).toEqual([`${E2E_METRIC}:1`]);
  await a.context.close();
  await b.context.close();
});

test('appends a query to an existing favorite and edits its statements', async ({ browser, request }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await selectMetric(page, E2E_GAUGE);
  const dialog = await saveChart(page, 'E2E requests', { existing: true });
  await expect(dialog.getByText(`Already in “E2E requests”`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await serverQueries(request, 1)).toEqual([`${E2E_METRIC}:1`, `${E2E_GAUGE}:1`]);

  await menuTree(page).getByText('E2E requests', { exact: true }).click();
  await page.getByRole('list', { name: 'Saved queries' }).getByText(E2E_GAUGE).click();
  await page.getByRole('region', { name: 'Visualization' }).getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit “E2E requests”' });
  await expect(editor.getByText('Loading queries…')).toHaveCount(0);
  // Open the second query and add a hand-written statement to it.
  await editor
    .getByRole('region', { name: `Query ${E2E_GAUGE}` })
    .getByRole('button', { name: 'Expand' })
    .click();
  const query = editor.getByRole('region', { name: `Query ${E2E_GAUGE}` });
  await query.getByRole('button', { name: 'Add statement' }).click();
  await query.getByPlaceholder('sum(rate(http_requests_total[5m]))').nth(1).fill(`max(${E2E_GAUGE})`);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();

  expect(await serverQueries(request, 1)).toEqual([`${E2E_METRIC}:1`, `${E2E_GAUGE}:2`]);
  // Every query of the favorite is shown at once, top to bottom.
  await expect(page.getByRole('region', { name: /^Saved query / })).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Statement 2 chart' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Statement 2 chart' }).getByText('1 series')).toBeVisible();
  await context.close();
});

test('manages folders: create, rename, move and delete', async ({ browser, request }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await page.getByRole('button', { name: 'Manage favorites' }).click();
  const manage = page.getByRole('dialog', { name: 'Manage favorites' });
  const tree = manage.getByRole('tree');
  await expect(tree.getByText('Window A', { exact: true })).toBeVisible();

  // With no folder selected, a new folder can only go to the top level.
  await manage.getByRole('button', { name: 'New folder' }).click();
  const newFolder = page.getByRole('dialog', { name: 'New folder' });
  await expect(newFolder.getByRole('radio')).toHaveCount(1);
  await expect(newFolder.getByLabel('Top level')).toBeChecked();
  await newFolder.getByLabel('Folder name').fill('E2E draft');
  await newFolder.getByRole('button', { name: 'Create' }).click();
  await expect(newFolder).toBeHidden();
  // Rename it in its own dialog; a name its siblings already use is refused.
  await manage.getByRole('button', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename folder' });
  await expect(rename.getByLabel('Name', { exact: true })).toHaveValue('E2E draft');
  await rename.getByLabel('Name', { exact: true }).fill('E2E requests');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(rename.getByText('“E2E requests” already exists in this folder.')).toBeVisible();
  await rename.getByLabel('Name', { exact: true }).fill('E2E folder');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(rename).toBeHidden();
  await expect(tree.getByText('E2E folder', { exact: true })).toBeVisible();
  // The new folder is selected, so the next one can go inside it.
  await manage.getByRole('button', { name: 'New folder' }).click();
  await expect(newFolder.getByLabel('Inside “E2E folder”')).toBeChecked();
  await newFolder.getByLabel('Folder name').fill('E2E inner');
  await newFolder.getByRole('button', { name: 'Create' }).click();
  await expect(newFolder).toBeHidden();
  // Dropped on the middle of a folder row, an entry goes inside, at the end.
  await tree.getByText('Window A', { exact: true }).dragTo(tree.getByText('E2E folder', { exact: true }));
  await tree.getByText('Window B', { exact: true }).click();
  await manage.getByRole('button', { name: 'Delete' }).click();
  // Grafana 12.3's ConfirmModal leaves its dialog unnamed, so find it by its heading.
  await page
    .getByRole('dialog')
    .filter({ hasText: 'Delete “Window B”?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  // A folder with something in it cannot be deleted.
  await tree.getByText('E2E folder', { exact: true }).click();
  await expect(manage.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await manage.getByRole('button', { name: /^Apply/ }).click();
  await expect(manage).toBeHidden();

  expect(await serverMenu(request)).toEqual([
    '1:E2E requests',
    { '4:E2E folder': [{ '5:E2E inner': [] }, '2:Window A'] },
  ]);
  expect((await readResource(request, user))?.data[contentKey(BigInt(3))]).toBeUndefined();
  await context.close();
});

test('another tab without an open editor refreshes after a save', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  const other = await context.newPage();
  await openApp(page);
  await openApp(other);
  await selectMetric(page, E2E_METRIC);
  const dialog = await saveChart(page, 'From tab 1');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  // No reload: the other tab learns about the save through BroadcastChannel.
  await expect(menuTree(other).getByText('From tab 1', { exact: true })).toBeVisible();
  await context.close();
});

test('a save whose response is lost is checked again and stored once', async ({ browser, request }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await selectMetric(page, E2E_GAUGE);
  const dialog = await saveChart(page, 'Window A', { existing: true });
  // The first write reaches Grafana, but the browser never sees the answer.
  let lost = false;
  await page.route('**/apis/userstorage.grafana.app/**', async (route) => {
    if (route.request().method() === 'PATCH' && !lost) {
      lost = true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('The query was already saved on the Grafana server.')).toBeVisible();
  expect(lost).toBe(true);
  expect(await serverQueries(request, 2)).toEqual([`${E2E_METRIC}:1`, `${E2E_GAUGE}:1`]);
  await context.close();
});

test('two windows editing one favorite: the later save reports a conflict and keeps its draft', async ({
  browser,
  request,
}) => {
  const a = await signedIn(browser, user);
  const b = await signedIn(browser, user);
  const editors = [];
  for (const { page } of [a, b]) {
    await openApp(page);
    await menuTree(page).getByText('E2E requests', { exact: true }).click();
    await page.getByRole('region', { name: 'Visualization' }).getByRole('button', { name: 'Edit' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit “E2E requests”' });
    await expect(editor.getByText('Loading queries…')).toHaveCount(0);
    editors.push(editor);
  }
  await editors[0].getByLabel('Query name').first().fill('Renamed in A');
  await editors[0].getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editors[0]).toBeHidden();

  await editors[1].getByLabel('Query name').first().fill('Renamed in B');
  await editors[1].getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editors[1].getByText('Favorites changed on the server')).toBeVisible();
  await expect(editors[1].getByText('On the server now')).toBeVisible();
  await expect(editors[1].getByLabel('Query name').first()).toHaveValue('Renamed in B');
  expect((await serverQueries(request, 1))[0]).toBe('Renamed in A:1');

  // Starting over from the server's version picks up A's change.
  await editors[1].getByRole('button', { name: 'Edit the latest version' }).click();
  await expect(editors[1].getByLabel('Query name').first()).toHaveValue('Renamed in A');
  await a.context.close();
  await b.context.close();
});

test('a tab with an open editor is told about another tab’s save instead of being refreshed', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  const other = await context.newPage();
  await openApp(page);
  await openApp(other);
  await other.getByRole('button', { name: 'Manage favorites' }).click();
  const manage = other.getByRole('dialog', { name: 'Manage favorites' });
  await expect(manage.getByRole('tree')).toBeVisible();

  await selectMetric(page, E2E_METRIC);
  const dialog = await saveChart(page, 'From tab 2');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(manage.getByText('Favorites changed in another window')).toBeVisible();
  await expect(manage.getByRole('tree').getByText('From tab 2', { exact: true })).toHaveCount(0);
  // Closing the editor brings the menu up to date.
  await manage.locator('button', { hasText: 'Close' }).click();
  await expect(menuTree(other).getByText('From tab 2', { exact: true })).toBeVisible();
  await context.close();
});

test('without a usable datasource the favorites still open and run', async ({ browser }) => {
  const { context, page } = await signedIn(browser, user);
  await page.route('**/resources/explorer/v1/datasources', (route) => route.fulfill({ status: 500, body: 'down' }));
  await page.goto('/a/ahfuzhang-victoriametricsexplorer-app');
  await expect(page.getByText('Cannot list the VictoriaMetrics datasources')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Favorites' })).toBeVisible();
  await menuTree(page).getByText('E2E requests', { exact: true }).click();
  const charts = page.getByRole('region', { name: /^Statement \d+ chart$/ });
  await expect(charts).toHaveCount(3);
  for (const chart of await charts.all()) {
    await expect(chart.getByText('1 series')).toBeVisible();
  }
  await context.close();
});

test('saves into a new favorite in the folder of the picked entry', async ({ browser, request }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await selectMetric(page, E2E_METRIC);
  await page.getByRole('button', { name: 'Save this chart to favorites' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save to favorites' });
  // Typing a name while a favorite is picked saves into a new favorite next to it instead.
  await dialog.getByRole('tree', { name: 'Choose where to save' }).getByText('Window A', { exact: true }).click();
  await expect(dialog.getByText('Already in “Window A”')).toBeVisible();
  await dialog.getByLabel('New favorite name').fill('E2E in folder');
  await expect(dialog.getByText('Created in “E2E folder”.')).toBeVisible();
  await expect(dialog.getByText('Already in “Window A”')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  expect(await serverMenu(request)).toContainEqual({
    '4:E2E folder': [{ '5:E2E inner': [] }, '2:Window A', expect.stringMatching(/^\d+:E2E in folder$/)],
  });
  await context.close();
});

test('creates a folder from the save dialog and saves a new favorite into it', async ({ browser, request }) => {
  const { context, page } = await signedIn(browser, user);
  await openApp(page);
  await selectMetric(page, E2E_METRIC);
  await page.getByRole('button', { name: 'Save this chart to favorites' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save to favorites' });
  const tree = dialog.getByRole('tree', { name: 'Choose where to save' });
  await tree.getByText('E2E folder', { exact: true }).click();
  await dialog.getByRole('button', { name: 'New folder' }).click();
  const newFolder = page.getByRole('dialog', { name: 'New folder' });
  await expect(newFolder.getByLabel('Inside “E2E folder”')).toBeChecked();
  await newFolder.getByLabel('Folder name').fill('E2E inner');
  await newFolder.getByRole('button', { name: 'Create' }).click();
  await expect(newFolder.getByText('“E2E inner” already exists in this folder.')).toBeVisible();
  await newFolder.getByLabel('Folder name').fill('E2E sub');
  await newFolder.getByRole('button', { name: 'Create' }).click();
  await expect(newFolder).toBeHidden();
  // The new folder is only a draft until the save, and is selected as the place for a new favorite.
  await expect(tree.getByRole('treeitem', { name: /E2E sub/, selected: true })).toBeVisible();
  await dialog.getByLabel('New favorite name').fill('E2E in sub');
  await expect(dialog.getByText('Created in “E2E folder / E2E sub”.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const folder = (await serverMenu(request)).find(
    (entry): entry is Record<string, unknown[]> => typeof entry === 'object' && '4:E2E folder' in entry!
  )!;
  const sub = folder['4:E2E folder'].at(-1) as Record<string, unknown[]>;
  expect(Object.keys(sub)).toEqual([expect.stringMatching(/^\d+:E2E sub$/)]);
  expect(Object.values(sub)).toEqual([[expect.stringMatching(/^\d+:E2E in sub$/)]]);
  await context.close();
});
