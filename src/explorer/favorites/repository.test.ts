/**
 * @jest-environment node
 */
import { MENU_KEY, contentKey } from './codec';
import { FavoritesRepository } from './repository';
import { DecodeCache, SnapshotView } from './snapshotView';
import { FakeUserStorageServer, encodeData, favorite, folder, query, tree } from './testUtils';
import {
  FavoritesBusy,
  FavoritesConflict,
  FavoritesTooLarge,
  FavoritesUncertain,
  ROOT,
  UserStorageError,
  type Operation,
} from './types';

const noSleep = { sleep: async () => undefined, now: () => 1_700_000_000_000 };

function repository(server: FakeUserStorageServer): FavoritesRepository {
  return new FavoritesRepository(server.adapter(), new DecodeCache(), noSleep);
}

async function menuNames(server: FakeUserStorageServer): Promise<string[]> {
  const view = new SnapshotView(server.resource, new DecodeCache());
  const menu = await view.menu();
  if (menu.state !== 'ok') {
    throw new Error(menu.message);
  }
  const names: string[] = [];
  const walk = (nodes: typeof menu.tree.children) =>
    nodes.forEach((node) => {
      names.push(`${node.id}:${node.name}`);
      walk(node.children);
    });
  walk(menu.tree.children);
  return names;
}

async function queriesOf(server: FakeUserStorageServer, id: number): Promise<string[]> {
  const read = await new SnapshotView(server.resource, new DecodeCache()).content(BigInt(id));
  if (read.state !== 'ok') {
    throw new Error(read.state);
  }
  return read.content.queries.map((q) => q.id);
}

const createFavorite = (name: string, ids: string[]): Operation => ({
  kind: 'createFavorite',
  position: { parentId: ROOT, afterId: null },
  name,
  tempId: `tmp-${name}`,
  queries: ids.map((id) => query(id)),
});

async function seed(server: FakeUserStorageServer, extra: Record<string, string> = {}) {
  server.resource = {
    resourceVersion: '100',
    data: await encodeData(tree(6, [folder(1, 'Services', [favorite(6, 'Latency')])]), { 6: [query('q1')] }, extra),
  };
}

describe('FavoritesRepository', () => {
  it('creates the resource on first save', async () => {
    const server = new FakeUserStorageServer();
    const result = await repository(server).commit([createFavorite('F', ['q'])], null);
    expect(result.idMap.get('tmp-F')).toBe(BigInt(1));
    expect(await menuNames(server)).toEqual(['1:F']);
    expect(await queriesOf(server, 1)).toEqual(['q']);
  });

  it('replays after AlreadyExists when two windows create the resource at once', async () => {
    const server = new FakeUserStorageServer();
    const a = repository(server);
    const b = repository(server);
    const baseB = await b.loadFresh(); // both saw "no resource"
    await a.commit([createFavorite('A', ['qa'])], null);
    const result = await b.commit([createFavorite('B', ['qb'])], baseB.snapshot ? baseB : null);
    expect(result.idMap.get('tmp-B')).toBe(BigInt(2));
    expect(await menuNames(server)).toEqual(['2:B', '1:A']);
  });

  it('gives two windows creating favorites different ids and keeps both (example 1)', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const a = repository(server);
    const b = repository(server);
    const baseA = await a.loadFresh();
    const baseB = await b.loadFresh();
    // B reads, then A writes before B's write lands: B gets a 409 and replays.
    let interleaved = false;
    server.beforeWrite = async () => {
      if (!interleaved) {
        interleaved = true;
        await a.commit([createFavorite('Errors', ['qe'])], baseA);
      }
    };
    const result = await b.commit([createFavorite('Throughput', ['qt'])], baseB);
    expect(result.idMap.get('tmp-Throughput')).toBe(BigInt(8));
    expect(await menuNames(server)).toEqual(['8:Throughput', '7:Errors', '1:Services', '6:Latency']);
    expect(await queriesOf(server, 7)).toEqual(['qe']);
    expect(await queriesOf(server, 8)).toEqual(['qt']);
  });

  it('keeps both queries when two windows append to one favorite (example 3)', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const a = repository(server);
    const b = repository(server);
    const baseA = await a.loadFresh();
    const baseB = await b.loadFresh();
    await a.commit([{ kind: 'appendQuery', favoriteId: '6', query: query('q2') }], baseA);
    await b.commit([{ kind: 'appendQuery', favoriteId: '6', query: query('q3') }], baseB);
    expect(await queriesOf(server, 6)).toEqual(['q1', 'q2', 'q3']);
  });

  it('reports a conflict and leaves the server alone when two windows edit one favorite (example 4)', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const a = repository(server);
    const b = repository(server);
    const baseA = await a.loadFresh();
    const baseB = await b.loadFresh();
    await a.commit([{ kind: 'editFavoriteQueries', favoriteId: '6', queries: [] }], baseA);
    const writes = server.writes;
    const err = await b
      .commit([{ kind: 'editFavoriteQueries', favoriteId: '6', queries: [query('q1', 'renamed')] }], baseB)
      .catch((e) => e);
    expect(err).toBeInstanceOf(FavoritesConflict);
    expect((err as FavoritesConflict).conflict.reason).toBe('contentChanged');
    expect((err as FavoritesConflict).latest?.resourceVersion).toBe(server.resource?.resourceVersion);
    expect(server.writes).toBe(writes);
    expect(await queriesOf(server, 6)).toEqual([]);
  });

  it('does not append twice when a write succeeded but its response was lost', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const repo = repository(server);
    const base = await repo.loadFresh();
    server.fail('commit', 'uncertain', 'after');
    const result = await repo.commit([{ kind: 'appendQuery', favoriteId: '6', query: query('q2') }], base);
    expect(result.alreadyApplied).toBe(true);
    expect(server.writes).toBe(1);
    expect(await queriesOf(server, 6)).toEqual(['q1', 'q2']);
  });

  it('does not create a favorite twice when the create response was lost', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const repo = repository(server);
    const base = await repo.loadFresh();
    server.fail('commit', 'uncertain', 'after');
    const result = await repo.commit([createFavorite('New', ['qn'])], base);
    expect(result.alreadyApplied).toBe(true);
    expect(result.idMap.get('tmp-New')).toBe(BigInt(7));
    expect(await menuNames(server)).toEqual(['7:New', '1:Services', '6:Latency']);
  });

  it('lets at most one of a delayed write and its retry land', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const repo = repository(server);
    const base = await repo.loadFresh();
    server.fail('commit', 'uncertain', 'delayed');
    await repo.commit([{ kind: 'appendQuery', favoriteId: '6', query: query('q2') }], base);
    const late = server.deliver();
    expect(late[0]).toBeInstanceOf(UserStorageError);
    expect((late[0] as UserStorageError).kind).toBe('versionConflict');
    expect(await queriesOf(server, 6)).toEqual(['q1', 'q2']);
  });

  it('gives up with FavoritesBusy after repeated conflicts', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    server.fail('commit', 'versionConflict', 'before', 4);
    const repo = repository(server);
    await expect(repo.commit([createFavorite('X', ['x'])], await repo.loadFresh())).rejects.toBeInstanceOf(
      FavoritesBusy
    );
  });

  it('gives up with FavoritesUncertain after repeated lost responses, and a re-check settles it', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    server.fail('commit', 'uncertain', 'before', 4);
    const repo = repository(server);
    const base = await repo.loadFresh();
    const ops: Operation[] = [{ kind: 'appendQuery', favoriteId: '6', query: query('q2') }];
    await expect(repo.commit(ops, base)).rejects.toBeInstanceOf(FavoritesUncertain);
    // "Check again" runs the same commit.
    const result = await repo.commit(ops, base);
    expect(result.alreadyApplied).toBe(false);
    expect(await queriesOf(server, 6)).toEqual(['q1', 'q2']);
  });

  it('retries throttling and does not retry forbidden or rejected', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const repo = repository(server);
    server.fail('commit', 'throttled');
    await repo.commit([createFavorite('T', ['t'])], await repo.loadFresh());

    server.fail('commit', 'forbidden');
    const writes = server.writes;
    const err = await repo.commit([createFavorite('U', ['u'])], await repo.loadFresh()).catch((e) => e);
    expect(err).toBeInstanceOf(UserStorageError);
    expect((err as UserStorageError).kind).toBe('forbidden');
    expect(server.writes).toBe(writes);
  });

  it('rethrows a read failure that outlasted every attempt as not saved', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    server.fail('load', 'uncertain', 'before', 4);
    const repo = repository(server);
    const err = await repo.commit([createFavorite('X', ['x'])], null).catch((e) => e);
    expect(err).toBeInstanceOf(UserStorageError);
    expect((err as UserStorageError).kind).toBe('uncertain');
    expect(server.writes).toBe(0);
  });

  it('leaves keys of other features untouched', async () => {
    const server = new FakeUserStorageServer();
    await seed(server, { 'other.feature': 'keep me' });
    const repo = repository(server);
    await repo.commit([{ kind: 'deleteFavorite', nodeId: '6' }], await repo.loadFresh());
    expect(server.resource?.data['other.feature']).toBe('keep me');
    expect(server.resource?.data[contentKey(BigInt(6))]).toBeUndefined();
    expect(server.resource?.data[MENU_KEY]).toBeDefined();
  });

  it('refuses to grow the resource past its budget but still allows deletes', async () => {
    const server = new FakeUserStorageServer();
    await seed(server, { 'other.feature': 'x'.repeat(1024 * 1024) });
    const repo = repository(server);
    await expect(repo.commit([createFavorite('Big', ['b'])], await repo.loadFresh())).rejects.toBeInstanceOf(
      FavoritesTooLarge
    );
    await repo.commit([{ kind: 'deleteFavorite', nodeId: '6' }], await repo.loadFresh());
  });

  it('runs the commits of one page one after another', async () => {
    const server = new FakeUserStorageServer();
    await seed(server);
    const repo = repository(server);
    const base = await repo.loadFresh();
    await Promise.all([
      repo.commit([{ kind: 'appendQuery', favoriteId: '6', query: query('a') }], base),
      repo.commit([{ kind: 'appendQuery', favoriteId: '6', query: query('b') }], base),
    ]);
    expect(await queriesOf(server, 6)).toEqual(['q1', 'a', 'b']);
    expect(server.writes).toBe(2);
  });

  it('never writes without a precondition', async () => {
    const server = new FakeUserStorageServer();
    await expect(server.adapter().commit('', { a: 'b' })).rejects.toMatchObject({ kind: 'rejected' });
  });
});
