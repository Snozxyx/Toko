/** Public gRPC-web contract used by Wuxiaworld's own web client. */
import { fetchResponse } from '../../utils/http/fetch.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Field = number | Uint8Array;
export type Message = Map<number, Field[]>;
const varint = (value: number) => { const bytes: number[] = []; do { const b = value % 128; value = Math.floor(value / 128); bytes.push(b | (value ? 128 : 0)); } while (value); return bytes; };
export function pbInt(field: number, value: number): Uint8Array { return new Uint8Array([...varint(field * 8), ...varint(value)]); }
export function pbBytes(field: number, value: Uint8Array): Uint8Array { return new Uint8Array([...varint(field * 8 + 2), ...varint(value.length), ...value]); }
export function pbString(field: number, value: string): Uint8Array { return pbBytes(field, encoder.encode(value)); }
export function concat(...parts: Uint8Array[]) { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result; }
export function decodeMessage(bytes: Uint8Array): Message {
  const fields: Message = new Map(); let at = 0;
  const readVar = () => { let value = 0, shift = 0; for (let n = 0; n < 10; n++) { if (at >= bytes.length) throw new Error('Truncated protobuf'); const byte = bytes[at++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) return value; shift += 7; } throw new Error('Invalid protobuf integer'); };
  while (at < bytes.length) {
    const tag = readVar(), field = Math.floor(tag / 8), wire = tag & 7;
    let value: Field;
    if (wire === 0) value = readVar();
    else if (wire === 2) { const length = readVar(); if (length > bytes.length - at) throw new Error('Truncated protobuf field'); value = bytes.slice(at, at + length); at += length; }
    else if (wire === 1 || wire === 5) { const size = wire === 1 ? 8 : 4; if (at + size > bytes.length) throw new Error('Truncated numeric field'); const view = new DataView(bytes.buffer, bytes.byteOffset + at, size); value = size === 8 ? view.getFloat64(0, true) : view.getFloat32(0, true); at += size; }
    else throw new Error('Unsupported protobuf wire type');
    const list = fields.get(field) || []; list.push(value); fields.set(field, list);
  }
  return fields;
}
export const pbText = (message: Message, field: number) => { const value = message.get(field)?.[0]; return value instanceof Uint8Array ? decoder.decode(value) : ''; };
export const pbNumber = (message: Message, field: number) => { const value = message.get(field)?.[0]; return typeof value === 'number' ? value : value instanceof Uint8Array ? Number(decodeMessage(value).get(1)?.[0] || 0) : 0; };
export const pbMessages = (message: Message, field: number): Message[] => (message.get(field) || []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(decodeMessage);
export async function wuxiaRpc(service: 'Novels' | 'Chapters', method: string, payload: Uint8Array): Promise<Message> {
  const frame = new Uint8Array(payload.length + 5); new DataView(frame.buffer).setUint32(1, payload.length); frame.set(payload, 5);
  const response = await fetchResponse(`https://api2.wuxiaworld.com/wuxiaworld.api.v2.${service}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' }, body: frame as any, timeoutMs: 20000 });
  if (!response.ok) throw new Error(`Wuxiaworld HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer()); let at = 0, data: Message | undefined;
  while (at + 5 <= bytes.length) {
    const flag = bytes[at], length = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(0); at += 5;
    if (length > bytes.length - at) throw new Error('Truncated Wuxiaworld response');
    const content = bytes.slice(at, at + length); at += length;
    if (flag & 128) { const trailer = decoder.decode(content); const status = trailer.match(/grpc-status:\s*(\d+)/i)?.[1]; if (status && status !== '0') throw new Error(`Wuxiaworld gRPC ${status}: ${trailer.match(/grpc-message:\s*([^\r\n]+)/i)?.[1] || 'request rejected'}`); }
    else data = decodeMessage(content);
  }
  if (!data) throw new Error('Wuxiaworld returned no data'); return data;
}
