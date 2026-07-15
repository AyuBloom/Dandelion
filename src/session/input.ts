import ByteBuffer from "bytebuffer";

import { PacketIds } from "../network/enums.ts";
import type { InputPacketData } from "../shared/packets.ts";

const MAX_INPUT_PACKET_BYTES = 1024;
const yawFields = new Set(["mouseDown", "mouseMoved", "mouseMovedWhileDown"]);
const mouseActionFields = new Set([...yawFields, "mouseUp"]);
const mouseFields = new Set([
  ...mouseActionFields,
  "worldX",
  "worldY",
  "distance",
]);
const allowedFields = new Set([
  "respawn",
  "up",
  "down",
  "left",
  "right",
  "space",
  ...yawFields,
  "mouseUp",
  "worldX",
  "worldY",
  "distance",
]);

export function parseListenerInput(
  packet: Uint8Array,
): InputPacketData | undefined {
  if (packet.byteLength < 2 || packet.byteLength > MAX_INPUT_PACKET_BYTES) {
    return undefined;
  }

  try {
    const buffer = ByteBuffer.wrap(packet);
    buffer.littleEndian = true;

    if (buffer.readUint8() !== PacketIds.PACKET_INPUT) return undefined;

    const input: unknown = JSON.parse(buffer.readVString());
    if (buffer.remaining() !== 0) return undefined;
    return parseInputPacketData(input);
  } catch {
    return undefined;
  }
}

export function mergeListenerInputs(
  previous: InputPacketData,
  next: InputPacketData,
): InputPacketData {
  const merged = { ...previous };

  if ([...mouseActionFields].some((field) => field in next)) {
    for (const field of mouseFields) {
      delete merged[field as keyof InputPacketData];
    }
  }

  return Object.assign(merged, next);
}

function parseInputPacketData(value: unknown): InputPacketData | undefined {
  const input = (value ?? {}) as Record<string, unknown>;
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;

  for (const [field, inputValue] of entries) {
    if (!allowedFields.has(field)) return undefined;

    if (field === "respawn" && inputValue !== 1) return undefined;

    if (yawFields.has(field)) {
      if (
        typeof inputValue !== "number" ||
        inputValue < 0 ||
        inputValue > 359
      ) {
        return undefined;
      }
    }
  }

  return input as InputPacketData;
}
