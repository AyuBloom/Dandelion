import ByteBuffer from "bytebuffer";

import { PacketIds, ParameterType } from "../network/enums.ts";
import type { RpcMapEntry } from "../shared/packets.ts";

export const MAX_RPC_PACKET_BYTES = 256;

export function isValidListenerRpc(
  packet: Uint8Array,
  rpcMaps: RpcMapEntry[],
): boolean {
  if (packet.byteLength < 5 || packet.byteLength > MAX_RPC_PACKET_BYTES) {
    return false;
  }

  try {
    const buffer = ByteBuffer.wrap(packet);
    buffer.littleEndian = true;

    if (buffer.readUint8() !== PacketIds.PACKET_RPC) return false;

    const rpc = rpcMaps[buffer.readUint32()];
    if (!rpc) return false;

    for (const parameter of rpc.parameters) {
      readParameter(buffer, parameter.type);
    }

    return buffer.remaining() === 0;
  } catch {
    return false;
  }
}

function readParameter(buffer: ByteBuffer, type: ParameterType): void {
  switch (type) {
    case ParameterType.Uint32:
      buffer.readUint32();
      break;
    case ParameterType.Int32:
    case ParameterType.Float:
      buffer.readInt32();
      break;
    case ParameterType.String:
      buffer.readVString();
      break;
    default:
      throw new Error(`Unsupported client RPC parameter type: ${type}`);
  }
}
