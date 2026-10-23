import { create, fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';

import {
  FavoriteContentSchema,
  TreeSchema,
  type FavoriteContent,
  type Tree,
} from '../../generated/explorer/user_storage_pb';
import { MAX_BASE64_LENGTH, MAX_CONTENT_BYTES, MAX_MENU_BYTES } from './limits';

// Every stored value is protobuf → gzip → standard Base64 (docs/plan_v3.md §6.1). This is
// independent of the zstd wire format of the Explorer backend.

export const MENU_KEY = 'favorites.menu.v1';
export const CONTENT_KEY_PREFIX = 'favorites.node.v1.';
/** Every key this feature owns starts with this. */
export const FAVORITES_KEY_PREFIX = 'favorites.';
/** The storage format version this code reads and writes. */
export const SCHEMA_VERSION = 1;

export function contentKey(nodeId: bigint): string {
  return `${CONTENT_KEY_PREFIX}${nodeId.toString()}`;
}

/** The node id in a content key, or null when the key is not one. */
export function nodeIdOfContentKey(key: string): bigint | null {
  if (!key.startsWith(CONTENT_KEY_PREFIX)) {
    return null;
  }
  const digits = key.slice(CONTENT_KEY_PREFIX.length);
  return /^[1-9][0-9]*$/.test(digits) ? BigInt(digits) : null;
}

export type CodecErrorKind = 'unsupported' | 'base64' | 'gzip' | 'protobuf' | 'tooLarge' | 'newerVersion' | 'invalid';

export class CodecError extends Error {
  constructor(
    readonly kind: CodecErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'CodecError';
  }
}

/** Whether this browser can gzip natively; favorites are unavailable without it. */
export function compressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

export async function encodeTree(tree: Tree): Promise<string> {
  return encodeMessage(TreeSchema, tree, MAX_MENU_BYTES, 'menu');
}

export async function decodeTree(value: string): Promise<Tree> {
  const tree = await decodeMessage(TreeSchema, value, MAX_MENU_BYTES, 'menu');
  checkSchemaVersion(tree.schemaVersion, 'menu');
  return tree;
}

export async function encodeContent(content: FavoriteContent): Promise<string> {
  return encodeMessage(FavoriteContentSchema, content, MAX_CONTENT_BYTES, 'favorite');
}

export async function decodeContent(value: string): Promise<FavoriteContent> {
  const content = await decodeMessage(FavoriteContentSchema, value, MAX_CONTENT_BYTES, 'favorite');
  checkSchemaVersion(content.schemaVersion, 'favorite');
  return content;
}

export function emptyTree(): Tree {
  return create(TreeSchema, { schemaVersion: SCHEMA_VERSION, maxTreeNodeId: BigInt(0) });
}

function checkSchemaVersion(version: number, what: string): void {
  if (version > SCHEMA_VERSION) {
    throw new CodecError('newerVersion', `The ${what} was saved by a newer version of the app (format ${version}).`);
  }
  if (version < 1) {
    throw new CodecError('invalid', `The ${what} has no format version.`);
  }
}

async function encodeMessage<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  maxBytes: number,
  what: string
): Promise<string> {
  const bytes = toBinary(schema, message);
  if (bytes.length > maxBytes) {
    throw new CodecError('tooLarge', `The ${what} is ${bytes.length} bytes; at most ${maxBytes} bytes can be saved.`);
  }
  const value = bytesToBase64(await gzip(bytes));
  if (value.length > MAX_BASE64_LENGTH) {
    throw new CodecError('tooLarge', `The ${what} does not fit in ${MAX_BASE64_LENGTH} encoded bytes.`);
  }
  return value;
}

async function decodeMessage<Desc extends DescMessage>(
  schema: Desc,
  value: string,
  maxBytes: number,
  what: string
): Promise<MessageShape<Desc>> {
  if (value.length > MAX_BASE64_LENGTH) {
    throw new CodecError('tooLarge', `The stored ${what} is larger than ${MAX_BASE64_LENGTH} bytes.`);
  }
  const bytes = await gunzip(base64ToBytes(value), maxBytes);
  try {
    // Unknown fields are kept (the protobuf-es default), so a message written by a newer minor
    // version survives being read, changed and written back by this one.
    return fromBinary(schema, bytes);
  } catch (err) {
    throw new CodecError('protobuf', `The stored ${what} is not valid protobuf: ${String(err)}`);
  }
}

// btoa/atob take "binary strings"; build them in slices so large arrays never become one huge
// argument list.
const BINARY_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + BINARY_CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard Base64: no whitespace, no URL alphabet, padded to a multiple of 4. */
export function base64ToBytes(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new CodecError('base64', 'The stored value is not valid Base64.');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CodecError('base64', 'The stored value is not valid Base64.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function streamOf(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      // Always backed by a plain ArrayBuffer here (toBinary or base64ToBytes), never a SharedArrayBuffer.
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!compressionSupported()) {
    throw new CodecError('unsupported', 'This browser cannot compress data (CompressionStream is missing).');
  }
  return readAll(streamOf(bytes).pipeThrough(new CompressionStream('gzip')), Number.POSITIVE_INFINITY);
}

/** Decompress, giving up as soon as the output passes maxBytes so a gzip bomb never fills memory. */
async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (!compressionSupported()) {
    throw new CodecError('unsupported', 'This browser cannot decompress data (DecompressionStream is missing).');
  }
  return readAll(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')), maxBytes);
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new CodecError('tooLarge', `The stored value decompresses to more than ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof CodecError) {
      throw err;
    }
    throw new CodecError('gzip', 'The stored value is not valid gzip data.');
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
