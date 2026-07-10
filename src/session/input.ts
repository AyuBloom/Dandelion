import ByteBuffer from "bytebuffer";

import { PacketIds } from "../network/enums.ts";
import type { InputPacketData } from "../shared/packets.ts";

const MAX_INPUT_PACKET_BYTES = 1024;
const toggleFields = new Set(["up", "down", "left", "right", "space"]);
const yawFields = new Set(["mouseDown", "mouseMoved", "mouseMovedWhileDown"]);
const positionFields = new Set(["worldX", "worldY", "distance"]);
const mouseActionFields = new Set([...yawFields, "mouseUp"]);
const mouseFields = new Set([...mouseActionFields, ...positionFields]);
const allowedFields = new Set([
  ...toggleFields,
  ...yawFields,
  "mouseUp", // bool as num
  ...positionFields,
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;

  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;

  let hasAction = false;
  let hasMouseAction = false;

  for (const [field, inputValue] of entries) {
    if (
      !allowedFields.has(field) ||
      typeof inputValue !== "number" ||
      !Number.isFinite(inputValue)
    ) {
      return undefined;
    }

    if (toggleFields.has(field)) {
      if (inputValue !== 0 && inputValue !== 1) return undefined;
      hasAction = true;
      continue;
    }

    if (yawFields.has(field)) {
      if (!Number.isInteger(inputValue) || inputValue < 0 || inputValue > 359) {
        return undefined;
      }
      hasAction = true;
      hasMouseAction = true;
      continue;
    }

    if (field === "mouseUp") {
      if (inputValue !== 1) return undefined;
      hasAction = true;
      hasMouseAction = true;
      continue;
    }

    if (
      (field === "worldX" || field === "worldY") &&
      !Number.isInteger(inputValue)
    ) {
      return undefined;
    }
    if (field === "distance" && inputValue < 0) return undefined;
  }

  const positionCount = [...positionFields].filter((field) => field in input).length;
  if (!hasAction || positionCount !== (hasMouseAction ? positionFields.size : 0)) {
    return undefined;
  }

  return input as InputPacketData;
}
