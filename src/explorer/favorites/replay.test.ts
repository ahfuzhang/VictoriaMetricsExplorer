/**
 * @jest-environment node
 */
import { clone } from '@bufbuild/protobuf';

import { NodeKind, SavedQuerySchema, type FavoriteContent } from '../../generated/explorer/user_storage_pb';
import { MENU_KEY, contentKey } from './codec';
import { MAX_QUERIES_PER_FAVORITE, MAX_TREE_DEPTH, MAX_TREE_NODES } from './limits';
import { replay, type ReplayResult } from './replay';
import { DecodeCache, SnapshotView } from './snapshotView';
import { favorite, folder, query, tree, view } from './testUtils';
import { ROOT, type Operation } from './types';

const NOW = 1_700_000_000_000;

function applied(result: ReplayResult) {
  if (result.kind !== 'apply') {
    throw new Error(`expected apply, got ${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
  }
  return result;
}

function conflictOf(result: ReplayResult) {
  if (result.kind !== 'conflict') {
    throw new Error(`expected conflict, got ${result.kind}`);
  }
  return result.conflict;
}

function names(result: ReplayResult): unknown {
  const menu = applied(result).tree!;
  const walk = (nodes: typeof menu.children): unknown =>
    nodes.map((node) =>
      node.children.length ? { [`${node.id}:${node.name}`]: walk(node.children) } : `${node.id}:${node.name}`
    );
  return walk(menu.children);
}

const at = (parentId: string, afterId: string | null = null) => ({ parentId, afterId });

describe('replay', () => {
  // Menu used by most cases:
  //   1 Services/
  //     2 Latency (favorite: q1)
  //     3 Errors  (favorite: q2)
  //   4 Empty/
  const menu = () =>
    tree(4, [folder(1, 'Services', [favorite(2, 'Latency'), favorite(3, 'Errors')]), folder(4, 'Empty')]);
  const contents = () => ({ 2: [query('q1')], 3: [query('q2')] });

  describe('createFolder / createFavorite', () => {
    it('allocates ids from the latest counter and records the draft id', async () => {
      const base = await view(menu(), contents());
      const latest = await view(tree(6, [...menu().children, folder(5, 'Other'), favorite(6, 'Fav')]), {
        ...contents(),
        6: [],
      });
      const result = applied(
        await replay(
          [
            { kind: 'createFolder', position: at(ROOT), name: ' New ', tempId: 'tmp-a' },
            { kind: 'createFavorite', position: at('tmp-a'), name: 'Inside', tempId: 'tmp-b', queries: [query('q9')] },
          ],
          base,
          latest,
          NOW
        )
      );
      expect(result.tree?.maxTreeNodeId).toBe(BigInt(8));
      expect(result.idMap).toEqual(
        new Map([
          ['tmp-a', BigInt(7)],
          ['tmp-b', BigInt(8)],
        ])
      );
      expect(names(result)).toEqual([
        { '7:New': ['8:Inside'] },
        { '1:Services': ['2:Latency', '3:Errors'] },
        '4:Empty',
        '5:Other',
        '6:Fav',
      ]);
      const content = result.contents.get(contentKey(BigInt(8))) as FavoriteContent;
      expect(content.nodeId).toBe(BigInt(8));
      expect(content.queries.map((q) => q.id)).toEqual(['q9']);
      expect(content.updatedAtMs).toBe(BigInt(NOW));
    });

    it('writes the content key of an empty favorite too', async () => {
      const result = applied(
        await replay(
          [{ kind: 'createFavorite', position: at(ROOT), name: 'E', tempId: 'tmp-e', queries: [] }],
          null,
          null,
          NOW
        )
      );
      expect(result.contents.get(contentKey(BigInt(1)))?.queries).toEqual([]);
    });

    it('places a node after its sibling, first, or last when the sibling is gone', async () => {
      const base = await view(menu(), contents());
      const after = applied(
        await replay([{ kind: 'createFolder', position: at('1', '2'), name: 'X', tempId: 'tmp-x' }], base, base, NOW)
      );
      expect(names(after)).toEqual([{ '1:Services': ['2:Latency', '5:X', '3:Errors'] }, '4:Empty']);
      const first = applied(
        await replay([{ kind: 'createFolder', position: at('1', null), name: 'X', tempId: 'tmp-x' }], base, base, NOW)
      );
      expect(names(first)).toEqual([{ '1:Services': ['5:X', '2:Latency', '3:Errors'] }, '4:Empty']);
      const gone = applied(
        await replay([{ kind: 'createFolder', position: at('1', '99'), name: 'X', tempId: 'tmp-x' }], base, base, NOW)
      );
      expect(names(gone)).toEqual([{ '1:Services': ['2:Latency', '3:Errors', '5:X'] }, '4:Empty']);
    });

    it('conflicts on a sibling with the same normalized name, but not on a different case', async () => {
      const base = await view(menu(), contents());
      const conflict = conflictOf(
        await replay([{ kind: 'createFolder', position: at(ROOT), name: '  Empty ', tempId: 'tmp-x' }], base, base, NOW)
      );
      expect(conflict).toMatchObject({ reason: 'nameTaken', nodeId: '4', opIndex: 0 });
      // "é" composed and decomposed are the same name after NFC.
      const accented = await view(tree(1, [folder(1, 'café')]), {});
      expect(
        conflictOf(
          await replay(
            [{ kind: 'createFolder', position: at(ROOT), name: 'café', tempId: 't' }],
            accented,
            accented,
            NOW
          )
        ).reason
      ).toBe('nameTaken');
      applied(
        await replay([{ kind: 'createFolder', position: at(ROOT), name: 'EMPTY', tempId: 'tmp-x' }], base, base, NOW)
      );
    });

    it('treats a same-named favorite holding all its queries as already applied', async () => {
      const base = await view(menu(), contents());
      const result = await replay(
        [{ kind: 'createFavorite', position: at('1'), name: 'Latency', tempId: 'tmp-l', queries: [query('q1')] }],
        base,
        base,
        NOW
      );
      expect(result).toEqual({ kind: 'alreadyApplied', idMap: new Map([['tmp-l', BigInt(2)]]) });
      expect(
        conflictOf(
          await replay(
            [
              {
                kind: 'createFavorite',
                position: at('1'),
                name: 'Latency',
                tempId: 'tmp-l',
                queries: [query('other')],
              },
            ],
            base,
            base,
            NOW
          )
        ).reason
      ).toBe('nameTaken');
    });

    it('conflicts when the parent is gone or is a favorite', async () => {
      const base = await view(menu(), contents());
      expect(
        conflictOf(
          await replay([{ kind: 'createFolder', position: at('99'), name: 'X', tempId: 't' }], base, base, NOW)
        ).reason
      ).toBe('parentMissing');
      expect(
        conflictOf(
          await replay([{ kind: 'createFolder', position: at('tmp-unknown'), name: 'X', tempId: 't' }], base, base, NOW)
        ).reason
      ).toBe('parentMissing');
      expect(
        conflictOf(await replay([{ kind: 'createFolder', position: at('2'), name: 'X', tempId: 't' }], base, base, NOW))
          .reason
      ).toBe('parentNotFolder');
    });

    it('enforces the depth and node count limits', async () => {
      let deep = folder(MAX_TREE_DEPTH, `d${MAX_TREE_DEPTH}`);
      for (let id = MAX_TREE_DEPTH - 1; id >= 1; id--) {
        deep = folder(id, `d${id}`, [deep]);
      }
      const deepView = await view(tree(MAX_TREE_DEPTH, [deep]), {});
      expect(
        conflictOf(
          await replay(
            [{ kind: 'createFolder', position: at(String(MAX_TREE_DEPTH)), name: 'x', tempId: 't' }],
            deepView,
            deepView,
            NOW
          )
        ).reason
      ).toBe('limit');

      const many = Array.from({ length: MAX_TREE_NODES }, (_, index) => folder(index + 1, `f${index + 1}`));
      const full = await view(tree(MAX_TREE_NODES, many), {});
      expect(
        conflictOf(
          await replay([{ kind: 'createFolder', position: at(ROOT), name: 'x', tempId: 't' }], full, full, NOW)
        ).reason
      ).toBe('limit');
      // Deleting still works over the limit.
      applied(await replay([{ kind: 'deleteFolder', nodeId: '1' }], full, full, NOW));
    });

    it('refuses to wrap the id counter', async () => {
      const menuAtMax = tree(1, [folder(1, 'a')]);
      menuAtMax.maxTreeNodeId = (BigInt(1) << BigInt(64)) - BigInt(1);
      const v = await view(menuAtMax, {});
      expect(
        conflictOf(await replay([{ kind: 'createFolder', position: at(ROOT), name: 'b', tempId: 't' }], v, v, NOW))
          .reason
      ).toBe('limit');
    });
  });

  describe('appendQuery', () => {
    it('appends to the latest list, keeping other windows’ queries', async () => {
      const base = await view(menu(), contents());
      const latest = await view(menu(), { ...contents(), 2: [query('q1'), query('qB')] });
      const result = applied(
        await replay([{ kind: 'appendQuery', favoriteId: '2', query: query('qA') }], base, latest, NOW)
      );
      expect(result.tree).toBeNull();
      expect(result.contents.get(contentKey(BigInt(2)))?.queries.map((q) => q.id)).toEqual(['q1', 'qB', 'qA']);
    });

    it('is already applied when the query id is present', async () => {
      const base = await view(menu(), contents());
      expect((await replay([{ kind: 'appendQuery', favoriteId: '2', query: query('q1') }], base, base, NOW)).kind).toBe(
        'alreadyApplied'
      );
    });

    it('conflicts when the favorite is gone, a folder, unreadable or full', async () => {
      const base = await view(menu(), contents());
      expect(
        conflictOf(await replay([{ kind: 'appendQuery', favoriteId: '99', query: query('x') }], base, base, NOW)).reason
      ).toBe('nodeMissing');
      expect(
        conflictOf(await replay([{ kind: 'appendQuery', favoriteId: '1', query: query('x') }], base, base, NOW)).reason
      ).toBe('notFavorite');
      const corrupt = await view(menu(), { 3: [query('q2')] }, '1', { [contentKey(BigInt(2))]: 'AAAA' });
      expect(
        conflictOf(await replay([{ kind: 'appendQuery', favoriteId: '2', query: query('x') }], base, corrupt, NOW))
          .reason
      ).toBe('contentUnreadable');
      const fullList = Array.from({ length: MAX_QUERIES_PER_FAVORITE }, (_, index) => query(`f${index}`));
      const full = await view(menu(), { ...contents(), 2: fullList });
      expect(
        conflictOf(await replay([{ kind: 'appendQuery', favoriteId: '2', query: query('x') }], base, full, NOW)).reason
      ).toBe('favoriteFull');
    });
  });

  describe('replaceQuery', () => {
    it('replaces in place when nobody else changed the query', async () => {
      const base = await view(menu(), { ...contents(), 2: [query('q1'), query('q3')] });
      const latest = await view(menu(), { ...contents(), 2: [query('q1'), query('q3'), query('q4')] });
      const replacement = query('q1', 'renamed', 'rate(x[5m])');
      const result = applied(
        await replay([{ kind: 'replaceQuery', favoriteId: '2', query: replacement }], base, latest, NOW)
      );
      const queries = result.contents.get(contentKey(BigInt(2)))!.queries;
      expect(queries.map((q) => q.name)).toEqual(['renamed', 'q3', 'q4']);
    });

    it('is already applied when the query already equals the replacement', async () => {
      const replacement = query('q1', 'renamed');
      const base = await view(menu(), contents());
      const latest = await view(menu(), { ...contents(), 2: [replacement] });
      expect(
        (
          await replay(
            [{ kind: 'replaceQuery', favoriteId: '2', query: clone(SavedQuerySchema, replacement) }],
            base,
            latest,
            NOW
          )
        ).kind
      ).toBe('alreadyApplied');
    });

    it('conflicts when the query was deleted or changed elsewhere', async () => {
      const base = await view(menu(), contents());
      const deleted = await view(menu(), { ...contents(), 2: [] });
      expect(
        conflictOf(
          await replay([{ kind: 'replaceQuery', favoriteId: '2', query: query('q1', 'n') }], base, deleted, NOW)
        ).reason
      ).toBe('queryMissing');
      const changed = await view(menu(), { ...contents(), 2: [query('q1', 'other window')] });
      expect(
        conflictOf(
          await replay([{ kind: 'replaceQuery', favoriteId: '2', query: query('q1', 'n') }], base, changed, NOW)
        ).reason
      ).toBe('queryChanged');
    });
  });

  describe('editFavoriteQueries', () => {
    it('writes the new list when the content key is unchanged since the base', async () => {
      const base = await view(menu(), contents());
      const latest = await view(tree(5, [...menu().children, folder(5, 'elsewhere')]), contents(), '2');
      const result = applied(
        await replay(
          [{ kind: 'editFavoriteQueries', favoriteId: '2', queries: [query('q1', 'x'), query('n')] }],
          base,
          latest,
          NOW
        )
      );
      expect(result.tree).toBeNull();
      expect(result.contents.get(contentKey(BigInt(2)))?.queries.map((q) => q.name)).toEqual(['x', 'n']);
    });

    it('is already applied when the lists are equal, and conflicts when the key changed', async () => {
      const base = await view(menu(), contents());
      expect(
        (await replay([{ kind: 'editFavoriteQueries', favoriteId: '2', queries: [query('q1')] }], base, base, NOW)).kind
      ).toBe('alreadyApplied');
      const changed = await view(menu(), { ...contents(), 2: [query('q2x')] });
      expect(
        conflictOf(
          await replay(
            [{ kind: 'editFavoriteQueries', favoriteId: '2', queries: [query('q1', 'n')] }],
            base,
            changed,
            NOW
          )
        )
      ).toMatchObject({ reason: 'contentChanged', nodeId: '2' });
    });

    it('rebuilds a missing content key only through this explicit edit', async () => {
      const missing = await view(menu(), { 3: [query('q2')] });
      const result = applied(
        await replay([{ kind: 'editFavoriteQueries', favoriteId: '2', queries: [] }], missing, missing, NOW)
      );
      expect(result.contents.get(contentKey(BigInt(2)))).toMatchObject({ nodeId: BigInt(2), queries: [] });
      expect(
        conflictOf(await replay([{ kind: 'appendQuery', favoriteId: '2', query: query('x') }], missing, missing, NOW))
          .reason
      ).toBe('contentUnreadable');
    });

    it('rejects a content stored under another id', async () => {
      const swapped = await view(menu(), contents());
      const data = { ...swapped.data, [contentKey(BigInt(2))]: swapped.data[contentKey(BigInt(3))] };
      const mismatched = new SnapshotView({ resourceVersion: '1', data }, new DecodeCache());
      expect(
        conflictOf(
          await replay([{ kind: 'editFavoriteQueries', favoriteId: '2', queries: [] }], mismatched, mismatched, NOW)
        ).reason
      ).toBe('contentUnreadable');
    });
  });

  describe('renameNode', () => {
    it('renames, is already applied when equal, conflicts when renamed elsewhere or taken', async () => {
      const base = await view(menu(), contents());
      expect(names(await replay([{ kind: 'renameNode', nodeId: '2', name: 'P99' }], base, base, NOW))).toEqual([
        { '1:Services': ['2:P99', '3:Errors'] },
        '4:Empty',
      ]);
      expect((await replay([{ kind: 'renameNode', nodeId: '2', name: ' Latency ' }], base, base, NOW)).kind).toBe(
        'alreadyApplied'
      );
      const renamed = await view(
        tree(4, [folder(1, 'Services', [favorite(2, 'Other'), favorite(3, 'Errors')]), folder(4, 'Empty')]),
        contents()
      );
      expect(
        conflictOf(await replay([{ kind: 'renameNode', nodeId: '2', name: 'P99' }], base, renamed, NOW)).reason
      ).toBe('nameChanged');
      expect(
        conflictOf(await replay([{ kind: 'renameNode', nodeId: '2', name: 'Errors' }], base, base, NOW)).reason
      ).toBe('nameTaken');
      expect(conflictOf(await replay([{ kind: 'renameNode', nodeId: '9', name: 'x' }], base, base, NOW)).reason).toBe(
        'nodeMissing'
      );
    });

    it('allows two renames of one node in a batch', async () => {
      const base = await view(menu(), contents());
      const ops: Operation[] = [
        { kind: 'renameNode', nodeId: '4', name: 'A' },
        { kind: 'renameNode', nodeId: '4', name: 'B' },
      ];
      expect(names(await replay(ops, base, base, NOW))).toEqual([{ '1:Services': ['2:Latency', '3:Errors'] }, '4:B']);
    });
  });

  describe('moveNode', () => {
    it('moves across folders and reorders within one', async () => {
      const base = await view(menu(), contents());
      expect(names(await replay([{ kind: 'moveNode', nodeId: '3', position: at('4') }], base, base, NOW))).toEqual([
        { '1:Services': ['2:Latency'] },
        { '4:Empty': ['3:Errors'] },
      ]);
      expect(names(await replay([{ kind: 'moveNode', nodeId: '2', position: at('1', '3') }], base, base, NOW))).toEqual(
        [{ '1:Services': ['3:Errors', '2:Latency'] }, '4:Empty']
      );
      expect(
        names(await replay([{ kind: 'moveNode', nodeId: '4', position: at(ROOT, null) }], base, base, NOW))
      ).toEqual(['4:Empty', { '1:Services': ['2:Latency', '3:Errors'] }]);
    });

    it('is already applied when the node already sits there', async () => {
      const base = await view(menu(), contents());
      expect((await replay([{ kind: 'moveNode', nodeId: '3', position: at('1', '2') }], base, base, NOW)).kind).toBe(
        'alreadyApplied'
      );
      expect((await replay([{ kind: 'moveNode', nodeId: '2', position: at('1', null) }], base, base, NOW)).kind).toBe(
        'alreadyApplied'
      );
    });

    it('rejects cycles, favorites as targets, name clashes and depth overflow', async () => {
      const base = await view(
        tree(6, [folder(1, 'A', [folder(5, 'B', [folder(6, 'C')])]), folder(4, 'C'), favorite(2, 'F')]),
        { 2: [] }
      );
      expect(
        conflictOf(await replay([{ kind: 'moveNode', nodeId: '1', position: at('6') }], base, base, NOW)).reason
      ).toBe('moveInvalid');
      expect(
        conflictOf(await replay([{ kind: 'moveNode', nodeId: '1', position: at('1') }], base, base, NOW)).reason
      ).toBe('moveInvalid');
      expect(
        conflictOf(await replay([{ kind: 'moveNode', nodeId: '4', position: at('2') }], base, base, NOW)).reason
      ).toBe('parentNotFolder');
      expect(
        conflictOf(await replay([{ kind: 'moveNode', nodeId: '4', position: at('5') }], base, base, NOW)).reason
      ).toBe('nameTaken');

      let deep = folder(20 + MAX_TREE_DEPTH - 2, 'leaf');
      for (let id = 20 + MAX_TREE_DEPTH - 3; id >= 20; id--) {
        deep = folder(id, `d${id}`, [deep]);
      }
      const deepView = await view(tree(40, [deep, folder(30, 'X', [folder(31, 'Y')])]), {});
      // Y-subtree height 1 fits at depth MAX; X-subtree height 2 does not.
      applied(
        await replay(
          [{ kind: 'moveNode', nodeId: '31', position: at(String(20 + MAX_TREE_DEPTH - 2)) }],
          deepView,
          deepView,
          NOW
        )
      );
      expect(
        conflictOf(
          await replay(
            [{ kind: 'moveNode', nodeId: '30', position: at(String(20 + MAX_TREE_DEPTH - 2)) }],
            deepView,
            deepView,
            NOW
          )
        ).reason
      ).toBe('limit');
    });
  });

  describe('deleteFavorite / deleteFolder', () => {
    it('removes the node and its content key together', async () => {
      const base = await view(menu(), contents());
      const result = applied(await replay([{ kind: 'deleteFavorite', nodeId: '2' }], base, base, NOW));
      expect(names(result)).toEqual([{ '1:Services': ['3:Errors'] }, '4:Empty']);
      expect(result.contents).toEqual(new Map([[contentKey(BigInt(2)), null]]));
      expect(result.tree?.maxTreeNodeId).toBe(BigInt(4));
    });

    it('is already applied when the node is gone; conflicts when its queries changed', async () => {
      const base = await view(menu(), contents());
      const gone = await view(tree(4, [folder(1, 'Services', [favorite(3, 'Errors')]), folder(4, 'Empty')]), {
        3: [query('q2')],
      });
      expect((await replay([{ kind: 'deleteFavorite', nodeId: '2' }], base, gone, NOW)).kind).toBe('alreadyApplied');
      const changed = await view(menu(), { ...contents(), 2: [query('q1'), query('new')] });
      const conflict = conflictOf(await replay([{ kind: 'deleteFavorite', nodeId: '2' }], base, changed, NOW));
      expect(conflict.reason).toBe('contentChanged');
      expect(conflict.message).toContain('2 queries');
    });

    it('only deletes empty folders', async () => {
      const base = await view(menu(), contents());
      expect(conflictOf(await replay([{ kind: 'deleteFolder', nodeId: '1' }], base, base, NOW)).reason).toBe(
        'folderNotEmpty'
      );
      applied(await replay([{ kind: 'deleteFolder', nodeId: '4' }], base, base, NOW));
      expect((await replay([{ kind: 'deleteFolder', nodeId: '77' }], base, base, NOW)).kind).toBe('alreadyApplied');
      expect(conflictOf(await replay([{ kind: 'deleteFolder', nodeId: '2' }], base, base, NOW)).reason).toBe(
        'notFolder'
      );
    });
  });

  describe('batches', () => {
    it('applies the remaining operations when some already happened', async () => {
      const base = await view(menu(), contents());
      const result = applied(
        await replay(
          [
            { kind: 'deleteFolder', nodeId: '77' },
            { kind: 'renameNode', nodeId: '4', name: 'Renamed' },
          ],
          base,
          base,
          NOW
        )
      );
      expect(names(result)).toEqual([{ '1:Services': ['2:Latency', '3:Errors'] }, '4:Renamed']);
    });

    it('reports the first conflicting operation and applies nothing', async () => {
      const base = await view(menu(), contents());
      const conflict = conflictOf(
        await replay(
          [
            { kind: 'renameNode', nodeId: '4', name: 'Renamed' },
            { kind: 'deleteFolder', nodeId: '1' },
          ],
          base,
          base,
          NOW
        )
      );
      expect(conflict).toMatchObject({ opIndex: 1, reason: 'folderNotEmpty' });
    });

    it('replays on an empty tree when the resource does not exist', async () => {
      const result = applied(
        await replay(
          [{ kind: 'createFavorite', position: at(ROOT), name: 'F', tempId: 'tmp-f', queries: [query('q')] }],
          null,
          null,
          NOW
        )
      );
      expect(result.idMap.get('tmp-f')).toBe(BigInt(1));
      expect(result.tree?.children[0].kind).toBe(NodeKind.FAVORITE);
      expect(
        conflictOf(await replay([{ kind: 'appendQuery', favoriteId: '1', query: query('x') }], null, null, NOW)).reason
      ).toBe('nodeMissing');
    });
  });

  describe('damaged data', () => {
    it('never reuses the id of a stored content key, even when the menu is missing', async () => {
      const full = await view(menu(), contents());
      const { [MENU_KEY]: _menu, ...withoutMenu } = full.data;
      const orphaned = new SnapshotView({ resourceVersion: '2', data: withoutMenu }, new DecodeCache());
      const result = applied(
        await replay(
          [{ kind: 'createFavorite', position: at(ROOT), name: 'New', tempId: 't', queries: [query('n')] }],
          orphaned,
          orphaned,
          NOW
        )
      );
      expect(result.idMap.get('t')).toBe(BigInt(4));
      expect(result.contents.has(contentKey(BigInt(2)))).toBe(false);
      expect(result.contents.has(contentKey(BigInt(3)))).toBe(false);
    });

    it('reports whether a clashing name belongs to a folder', async () => {
      const base = await view(menu(), contents());
      expect(
        conflictOf(
          await replay(
            [{ kind: 'createFavorite', position: at(ROOT), name: 'Empty', tempId: 't', queries: [query('x')] }],
            base,
            base,
            NOW
          )
        )
      ).toMatchObject({ reason: 'nameTaken', nodeId: '4', nodeIsFolder: true });
    });

    it('refuses to write over a menu it cannot read', async () => {
      const base = await view(menu(), contents());
      const broken = new SnapshotView(
        { resourceVersion: '2', data: { ...base.data, [MENU_KEY]: 'AAAA' } },
        new DecodeCache()
      );
      expect(
        conflictOf(
          await replay([{ kind: 'createFolder', position: at(ROOT), name: 'x', tempId: 't' }], base, broken, NOW)
        ).reason
      ).toBe('menuUnreadable');
    });

    it('resets every favorites key, leaving other keys, only when the menu is as the user saw it', async () => {
      const broken = new SnapshotView(
        {
          resourceVersion: '2',
          data: { [MENU_KEY]: 'AAAA', [contentKey(BigInt(2))]: 'x', 'favorites.junk': 'y', other: 'keep' },
        },
        new DecodeCache()
      );
      const result = applied(await replay([{ kind: 'resetFavorites' }], broken, broken, NOW));
      // Ids keep counting from the highest one stored, so none is ever reused.
      expect(result.tree?.maxTreeNodeId).toBe(BigInt(2));
      expect(result.tree?.children).toEqual([]);
      expect([...result.contents.keys()].sort()).toEqual(['favorites.junk', contentKey(BigInt(2))]);
      const moved = new SnapshotView(
        { resourceVersion: '3', data: { ...broken.data, [MENU_KEY]: 'BBBB' } },
        new DecodeCache()
      );
      expect(conflictOf(await replay([{ kind: 'resetFavorites' }], broken, moved, NOW)).reason).toBe('contentChanged');
    });
  });
});
