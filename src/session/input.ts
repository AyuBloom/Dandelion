import ByteBuffer from "bytebuffer";

import { PacketIds } from "../network/enums.ts";
import type { InputPacketData } from "../shared/packets.ts";

const MAX_INPUT_PACKET_BYTES = 1024;
const toggleFields = new Set(["up", "down", "left", "right", "space"]);
const yawFields = new Set(["mouseDown", "mouseMoved", "mouseMovedWhileDown"]);
const positionFields = new Set(["worldX", "worldY", "distance"]);
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
    if (buffer.remaining() !== 0 || !isInputPacketData(input)) return undefined;
    return input;
  } catch {
    return undefined;
  }
}

function isInputPacketData(value: unknown): value is InputPacketData {
  if (!isRecord(value)) return false;

  const entries = Object.entries(value);
  if (entries.length === 0) return false;

  let hasAction = false;
  let hasMouseAction = false;

  for (const [field, inputValue] of entries) {
    if (
      !allowedFields.has(field) ||
      typeof inputValue !== "number" ||
      !Number.isFinite(inputValue)
    ) {
      return false;
    }

    if (toggleFields.has(field)) {
      if (inputValue !== 0 && inputValue !== 1) return false;
      hasAction = true;
      continue;
    }

    if (yawFields.has(field)) {
      if (!Number.isInteger(inputValue) || inputValue < 0 || inputValue > 359) {
        return false;
      }
      hasAction = true;
      hasMouseAction = true;
      continue;
    }

    if (field === "mouseUp") {
      if (inputValue !== 1) return false;
      hasAction = true;
      hasMouseAction = true;
      continue;
    }

    if (
      (field === "worldX" || field === "worldY") &&
      !Number.isInteger(inputValue)
    ) {
      return false;
    }
    if (field === "distance" && inputValue < 0) return false;
  }

  const positionCount = [...positionFields].filter((field) => field in value).length;
  return hasAction && positionCount === (hasMouseAction ? positionFields.size : 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
