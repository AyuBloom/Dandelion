import ByteBuffer from "bytebuffer";
import type { Vector2 } from "../shared/packets.ts";

interface Varint32Result {
  value: number;
  length: number;
}

interface Utf8StringResult {
  string: string;
  length: number;
}

export function safeReadVString(buffer: ByteBuffer): string {
  let offset = buffer.offset;
  const length = readVarint32(buffer, offset);

  try {
    const str = buffer.readUTF8String(
      length.value,
      ByteBuffer.METRICS_BYTES,
      offset + length.length,
    ) as Utf8StringResult;
    offset += length.length + str.length;
    buffer.offset = offset;
    return str.string;
  } catch {
    buffer.offset = offset + length.length + length.value;
    return "?";
  }
}

export function readVector2(buffer: ByteBuffer): Vector2 {
  return {
    x: buffer.readInt32() / 100,
    y: buffer.readInt32() / 100,
  };
}

export function readUint64(buffer: ByteBuffer): number {
  return buffer.readUint32() + buffer.readUint32() * 4294967296;
}

export function readInt64(buffer: ByteBuffer): number {
  let low = buffer.readUint32();
  const high = buffer.readInt32();
  if (high < 0) low *= -1;
  return low + high * 4294967296;
}

export function readVarint32(buffer: ByteBuffer, offset?: number): Varint32Result {
  const result =
    offset === undefined ? buffer.readVarint32() : buffer.readVarint32(offset);
  return typeof result === "number" ? { value: result, length: 0 } : result;
}
