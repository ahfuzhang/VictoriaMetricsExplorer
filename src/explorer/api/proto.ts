import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';

import {
  ErrorSchema,
  type LabelFilterSchema,
  type SchemaVersion,
  type TimeRange as TimeRangePb,
  type TimeRangeSchema,
} from '../../generated/explorer/explorer_pb';
import { zstdDecompress, zstdFrame } from './zstd';

/**
 * The backend's wire format, in both directions: a protobuf message compressed with zstd
 * (see proto/explorer/explorer.proto).
 */
const CONTENT_TYPE = 'application/x-protobuf';
const ENCODING_HEADER = 'X-Payload-Encoding';

interface Call<Req extends DescMessage, Res extends DescMessage> {
  url: string;
  method: 'GET' | 'POST';
  response: Res;
  request?: { schema: Req; init: MessageInitShape<Req> };
  showErrorAlert?: boolean;
  /** Aborting it cancels the request; the call then rejects. */
  abortSignal?: AbortSignal;
}

/** Send a request in the wire format and decode the response message. */
export async function callProto<Req extends DescMessage, Res extends DescMessage>(
  call: Call<Req, Res>
): Promise<MessageShape<Res>> {
  const headers: Record<string, string> = { Accept: CONTENT_TYPE };
  let data: Blob | undefined;
  if (call.request) {
    const bytes = zstdFrame(toBinary(call.request.schema, create(call.request.schema, call.request.init)));
    // Grafana's fetch passes a Blob through untouched instead of JSON-encoding it.
    data = new Blob([bytes], { type: CONTENT_TYPE });
    headers['Content-Type'] = CONTENT_TYPE;
    headers[ENCODING_HEADER] = 'zstd';
  }

  let resp;
  try {
    resp = await lastValueFrom(
      getBackendSrv().fetch<ArrayBuffer>({
        url: call.url,
        method: call.method,
        data,
        headers,
        responseType: 'arraybuffer',
        showErrorAlert: call.showErrorAlert,
        abortSignal: call.abortSignal,
      })
    );
  } catch (err) {
    throw withDecodedErrorBody(err);
  }
  return fromBinary(call.response, zstdDecompress(new Uint8Array(resp.data)));
}

/**
 * A failed request carries its body as raw bytes. The backend sends an explorer.Error; Grafana
 * itself (or a proxy in front of it) may answer with JSON or text. Turn whichever it is into the
 * `{ code, message, requestId }` object describeError reads.
 */
function withDecodedErrorBody(err: unknown): unknown {
  const e = err as { data?: unknown } | null;
  if (!e || typeof e !== 'object' || !(e.data instanceof ArrayBuffer)) {
    return err;
  }
  const bytes = new Uint8Array(e.data);
  try {
    const pb = fromBinary(ErrorSchema, zstdDecompress(bytes));
    return { ...e, data: { code: pb.code, message: pb.message, requestId: pb.requestId } };
  } catch {
    // Not the backend's format.
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { ...e, data: JSON.parse(text) };
  } catch {
    return { ...e, data: text };
  }
}

/** A request TimeRange; unset or 0 ends make the backend use its default range. */
export function timeRange(startMs?: number, endMs?: number): MessageInitShape<typeof TimeRangeSchema> {
  return { startMs: BigInt(Math.trunc(startMs ?? 0)), endMs: BigInt(Math.trunc(endMs ?? 0)) };
}

/** A decoded TimeRange as plain numbers. */
export function rangeFromProto(r?: TimeRangePb): { startMs: number; endMs: number } {
  return { startMs: Number(r?.startMs ?? 0), endMs: Number(r?.endMs ?? 0) };
}

/** The UI's label filters (label -> accepted values) as request LabelFilters. */
export function labelFilters(filters?: Record<string, string[]>): Array<MessageInitShape<typeof LabelFilterSchema>> {
  return Object.entries(filters ?? {}).map(([name, values]) => ({ name, values }));
}

export function schemaFromProto(s?: SchemaVersion): { major: number; minor: number } {
  return { major: s?.major ?? 0, minor: s?.minor ?? 0 };
}
