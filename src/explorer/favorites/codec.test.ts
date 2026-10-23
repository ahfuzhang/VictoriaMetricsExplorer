/**
 * @jest-environment node
 */
import { create } from '@bufbuild/protobuf';
import { WireType } from '@bufbuild/protobuf/wire';

import {
  FavoriteContentSchema,
  QueryStatementSchema,
  SavedQuerySchema,
} from '../../generated/explorer/user_storage_pb';
import {
  CodecError,
  base64ToBytes,
  bytesToBase64,
  contentKey,
  decodeContent,
  decodeTree,
  encodeContent,
  encodeTree,
  nodeIdOfContentKey,
} from './codec';
import { MAX_BASE64_LENGTH } from './limits';
import { favorite, folder, query, statement, tree } from './testUtils';

async function gzipRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function codecError(promise: Promise<unknown>): Promise<CodecError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CodecError);
    return err as CodecError;
  }
  throw new Error('expected a CodecError');
}

describe('codec', () => {
  it('round-trips a menu with unicode names and ids beyond 2^53', async () => {
    const big = (BigInt(1) << BigInt(60)) + BigInt(7);
    const menu = tree(0, [folder(1, '服务监控 📈', [favorite(2, 'line\nbreak')])]);
    menu.maxTreeNodeId = big;
    menu.children[0].children[0].id = big;
    const decoded = await decodeTree(await encodeTree(menu));
    expect(decoded.maxTreeNodeId).toBe(big);
    expect(decoded.children[0].name).toBe('服务监控 📈');
    expect(decoded.children[0].children[0].name).toBe('line\nbreak');
    expect(decoded.children[0].children[0].id).toBe(big);
  });

  it('round-trips an empty favorite and one with several queries and statements', async () => {
    const empty = create(FavoriteContentSchema, { schemaVersion: 1, nodeId: BigInt(3) });
    expect((await decodeContent(await encodeContent(empty))).queries).toEqual([]);

    const content = create(FavoriteContentSchema, {
      schemaVersion: 1,
      nodeId: BigInt(4),
      updatedAtMs: BigInt(1_700_000_000_000),
      queries: [
        create(SavedQuerySchema, {
          id: 'q1',
          name: 'P95/P99 延迟',
          statements: [statement('histogram_quantile(0.95, x)'), statement('histogram_quantile(0.99, x)', 'ds2')],
        }),
        query('q2', 'rate'),
      ],
    });
    const decoded = await decodeContent(await encodeContent(content));
    expect(decoded.queries.map((q) => q.statements.length)).toEqual([2, 1]);
    expect(decoded.queries[0].statements[1].datasourceUid).toBe('ds2');
    expect(decoded.updatedAtMs).toBe(BigInt(1_700_000_000_000));
  });

  it('keeps unknown fields so a newer minor version survives a rewrite', async () => {
    const stmt = create(QueryStatementSchema, { expression: 'up', datasourceUid: 'ds' });
    stmt.$unknown = [{ no: 99, wireType: WireType.Varint, data: new Uint8Array([7]) }];
    const content = create(FavoriteContentSchema, {
      schemaVersion: 1,
      nodeId: BigInt(1),
      queries: [create(SavedQuerySchema, { id: 'q', name: 'q', statements: [stmt] })],
    });
    const decoded = await decodeContent(await encodeContent(content));
    const again = await decodeContent(await encodeContent(decoded));
    expect(again.queries[0].statements[0].$unknown).toEqual([
      { no: 99, wireType: WireType.Varint, data: new Uint8Array([7]) },
    ]);
  });

  it('rejects data written by a newer format version', async () => {
    const menu = tree(0, []);
    menu.schemaVersion = 2;
    const err = await codecError(decodeTree(await encodeTree(menu)));
    expect(err.kind).toBe('newerVersion');
  });

  it('rejects malformed Base64, gzip and protobuf', async () => {
    expect((await codecError(decodeTree('not base64!'))).kind).toBe('base64');
    expect((await codecError(decodeTree('abc'))).kind).toBe('base64');
    expect((await codecError(decodeTree(bytesToBase64(new Uint8Array([1, 2, 3, 4]))))).kind).toBe('gzip');
    const garbage = bytesToBase64(await gzipRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff])));
    expect((await codecError(decodeTree(garbage))).kind).toBe('protobuf');
  });

  it('stops decompressing as soon as the output passes the limit', async () => {
    const bomb = bytesToBase64(await gzipRaw(new Uint8Array(600 * 1024)));
    expect(bomb.length).toBeLessThan(10_000);
    expect((await codecError(decodeContent(bomb))).kind).toBe('tooLarge');
  });

  it('refuses oversized Base64 before decoding it', async () => {
    expect((await codecError(decodeTree('A'.repeat(MAX_BASE64_LENGTH + 4)))).kind).toBe('tooLarge');
  });

  it('encodes Base64 in chunks without overflowing the call stack', () => {
    const bytes = new Uint8Array(MAX_BASE64_LENGTH).map((_, index) => index % 251);
    // Buffer comparison: Jest's element-wise toEqual takes seconds on arrays this long.
    expect(Buffer.from(base64ToBytes(bytesToBase64(bytes))).equals(Buffer.from(bytes))).toBe(true);
  });

  it('maps node ids to content keys and back', () => {
    expect(contentKey(BigInt(12))).toBe('favorites.node.v1.12');
    expect(nodeIdOfContentKey('favorites.node.v1.12')).toBe(BigInt(12));
    expect(nodeIdOfContentKey('favorites.node.v1.012')).toBeNull();
    expect(nodeIdOfContentKey('favorites.menu.v1')).toBeNull();
  });
});
