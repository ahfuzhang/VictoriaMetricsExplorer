#!/usr/bin/env node
// Contract checks for the Grafana User Storage API the favorites feature relies on (docs/plan_v3.md
// §4.3). Runs against a live Grafana with basic auth; creates a temporary Viewer user and only
// touches resources under the throwaway service name below, then removes them.
//
//   node tests/userstorage/contract.mjs http://admin:admin@localhost:3000
//
// Exits non-zero when any check fails.

const SERVICE = 'vmexplorer-contract-test';
const VIEWER = { login: 'vmexplorer-contract-viewer', password: 'contract-viewer-pass-1' };

const base = new URL(process.argv[2] ?? 'http://admin:admin@localhost:3000');
const admin = { user: decodeURIComponent(base.username), password: decodeURIComponent(base.password) };
base.username = '';
base.password = '';
const origin = base.toString().replace(/\/$/, '');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function call(auth, method, path, body, contentType = 'application/json') {
  const headers = { Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}` };
  if (body !== undefined) {
    headers['Content-Type'] = contentType;
  }
  const res = await fetch(origin + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const settings = (await call(admin, 'GET', '/api/frontend/settings')).json;
const health = (await call(admin, 'GET', '/api/health')).json;
const namespace = settings?.namespace ?? 'default';
const me = (await call(admin, 'GET', '/api/user')).json;
const adminUid = me.uid || String(me.id);
console.log(`Grafana ${health?.version} · namespace ${namespace} · admin uid ${adminUid}`);

const group = '/apis/userstorage.grafana.app/v0alpha1';
const collection = `${group}/namespaces/${namespace}/user-storage`;
const name = `${SERVICE}:${adminUid}`;
const item = `${collection}/${encodeURIComponent(name)}`;
const patch = (auth, path, body) => call(auth, 'PATCH', path, body, 'application/merge-patch+json');

// Start clean in case an earlier run was interrupted.
await call(admin, 'DELETE', item);

const discovery = await call(admin, 'GET', group);
check(
  'discovery lists user-storage',
  discovery.status === 200 && discovery.json?.resources?.some((r) => r.name === 'user-storage')
);

const missing = await call(admin, 'GET', item);
check(
  'missing resource: 404 Status NotFound with group + name',
  missing.status === 404 &&
    missing.json?.kind === 'Status' &&
    missing.json?.reason === 'NotFound' &&
    missing.json?.details?.group === 'userstorage.grafana.app' &&
    missing.json?.details?.name === name,
  JSON.stringify(missing.json?.details)
);

const noRoute = await call(
  admin,
  'GET',
  `/apis/userstorage.grafana.app/v0alpha999/namespaces/${namespace}/user-storage/${encodeURIComponent(name)}`
);
check(
  'missing route: 404 without the resource group in details',
  noRoute.status === 404 && noRoute.json?.details?.group !== 'userstorage.grafana.app',
  `status ${noRoute.status}`
);

const created = await call(admin, 'POST', `${collection}/`, {
  metadata: { name, labels: { user: adminUid, service: SERVICE } },
  spec: { data: { a: '1', other: 'keep' } },
});
const rv1 = created.json?.metadata?.resourceVersion;
check('create: 201 with resourceVersion', created.status === 201 && typeof rv1 === 'string' && rv1 !== '', `rv ${rv1}`);

const again = await call(admin, 'POST', `${collection}/`, { metadata: { name }, spec: { data: { a: '2' } } });
check('second create: 409 AlreadyExists', again.status === 409 && again.json?.reason === 'AlreadyExists');

const patched = await patch(admin, item, {
  metadata: { resourceVersion: rv1 },
  spec: { data: { a: null, b: 'B', c: 'C' } },
});
const rv2 = patched.json?.metadata?.resourceVersion;
check(
  'conditional merge patch: several keys in one change, null deletes, other keys kept',
  patched.status === 200 &&
    rv2 !== rv1 &&
    JSON.stringify(patched.json?.spec?.data) === JSON.stringify({ b: 'B', c: 'C', other: 'keep' }),
  JSON.stringify(patched.json?.spec?.data)
);

const read = await call(admin, 'GET', item);
check('read after write sees the new version', read.json?.metadata?.resourceVersion === rv2);

const stale = await patch(admin, item, { metadata: { resourceVersion: rv1 }, spec: { data: { b: 'STALE', d: 'D' } } });
check('stale resourceVersion: 409 Conflict', stale.status === 409 && stale.json?.reason === 'Conflict');
const afterStale = await call(admin, 'GET', item);
check(
  'rejected patch changed nothing',
  afterStale.json?.metadata?.resourceVersion === rv2 &&
    afterStale.json?.spec?.data?.b === 'B' &&
    !('d' in afterStale.json?.spec?.data),
  JSON.stringify(afterStale.json?.spec?.data)
);

const racers = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    patch(admin, item, { metadata: { resourceVersion: rv2 }, spec: { data: { race: String(i) } } })
  )
);
const winners = racers.filter((r) => r.status === 200).length;
const conflicts = racers.filter((r) => r.status === 409 && r.json?.reason === 'Conflict').length;
check(
  '8 concurrent patches on one version: exactly one wins',
  winners === 1 && conflicts === 7,
  `${winners} won, ${conflicts} conflicted`
);

const big = 'A'.repeat(2 * 1024 * 1024);
const rv3 = (await call(admin, 'GET', item)).json?.metadata?.resourceVersion;
const large = await patch(admin, item, { metadata: { resourceVersion: rv3 }, spec: { data: { big } } });
console.log(`INFO  2 MiB value: HTTP ${large.status} (the app enforces its own 1 MiB resource budget)`);
await patch(admin, item, { spec: { data: { big: null } } });

const gone = await patch(admin, `${collection}/${encodeURIComponent(`${SERVICE}-missing:${adminUid}`)}`, {
  metadata: { resourceVersion: '1' },
  spec: { data: { x: '1' } },
});
check('patch of a missing resource: 404 NotFound', gone.status === 404 && gone.json?.reason === 'NotFound');

// Isolation between ordinary users.
const createdUser = await call(admin, 'POST', '/api/admin/users', { name: 'contract viewer', ...VIEWER, OrgId: 1 });
let viewerId = createdUser.json?.id;
if (!viewerId) {
  viewerId = (await call(admin, 'GET', `/api/users/lookup?loginOrEmail=${VIEWER.login}`)).json?.id;
}
const viewerUid = (await call(admin, 'GET', `/api/users/${viewerId}`)).json?.uid || String(viewerId);
const viewer = { user: VIEWER.login, password: VIEWER.password };
const viewerItem = `${collection}/${encodeURIComponent(`${SERVICE}:${viewerUid}`)}`;
try {
  check('viewer cannot read another user', (await call(viewer, 'GET', item)).status === 403);
  check(
    'viewer cannot patch another user',
    (await patch(viewer, item, { spec: { data: { evil: '1' } } })).status === 403
  );
  const foreign = await call(viewer, 'POST', `${collection}/`, {
    metadata: { name: `${SERVICE}-x:${adminUid}` },
    spec: { data: {} },
  });
  check(
    'viewer cannot create under another user name',
    foreign.status === 403 || foreign.status === 422,
    `HTTP ${foreign.status}`
  );
  check('viewer cannot list', (await call(viewer, 'GET', collection)).status === 403);
  const own = await call(viewer, 'POST', `${collection}/`, {
    metadata: { name: `${SERVICE}:${viewerUid}` },
    spec: { data: { v: '1' } },
  });
  check('viewer can create its own resource', own.status === 201);
  const adminRead = await call(admin, 'GET', viewerItem);
  console.log(`INFO  Grafana Admin reading the viewer's resource: HTTP ${adminRead.status} (documented, not a defect)`);
} finally {
  await call(admin, 'DELETE', viewerItem);
  await call(admin, 'DELETE', item);
  await call(admin, 'DELETE', `/api/admin/users/${viewerId}`);
}

console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
