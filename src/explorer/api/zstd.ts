import { decompress } from 'fzstd';

export { decompress as zstdDecompress };

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** Largest block a frame may carry (Block_Maximum_Size). */
const MAX_BLOCK_SIZE = 128 * 1024;

/**
 * Wrap data in a zstd frame of raw (stored) blocks. The result is a valid zstd frame that any
 * decoder accepts, without being compressed: request bodies are a few hundred bytes, so a real
 * compressor (a WebAssembly module) would cost far more than it saves. The backend test
 * TestDecodeAcceptsRawBlockFrames (pkg/wire) checks the same layout.
 */
export function zstdFrame(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = data.length;
  // Frame header: magic, descriptor (Single_Segment_flag set, so no window descriptor) and the
  // content size in 1, 2 (minus 256) or 4 bytes.
  const header: number[] = [...ZSTD_MAGIC];
  if (n < 256) {
    header.push(0x20, n);
  } else if (n < 65536 + 256) {
    const v = n - 256;
    header.push(0x60, v & 0xff, v >>> 8);
  } else {
    header.push(0xa0, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  }

  const blocks = Math.max(1, Math.ceil(n / MAX_BLOCK_SIZE));
  const out = new Uint8Array(header.length + blocks * 3 + n);
  out.set(header, 0);
  let pos = header.length;
  for (let offset = 0, i = 0; i < blocks; i++) {
    const size = Math.min(n - offset, MAX_BLOCK_SIZE);
    // Block header, little-endian: Last_Block bit, Block_Type 0 (raw), Block_Size.
    const blockHeader = size * 8 + (i === blocks - 1 ? 1 : 0);
    out[pos++] = blockHeader & 0xff;
    out[pos++] = (blockHeader >>> 8) & 0xff;
    out[pos++] = (blockHeader >>> 16) & 0xff;
    out.set(data.subarray(offset, offset + size), pos);
    pos += size;
    offset += size;
  }
  return out;
}
