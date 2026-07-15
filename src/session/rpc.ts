import { PacketIds } from "../network/enums.ts";
import type { RpcMapEntry } from "../shared/packets.ts";

export const MAX_RPC_PACKET_BYTES = 256;

export function isValidListenerRpc(
  packet: Uint8Array,
  rpcMaps: RpcMapEntry[],
): boolean {
  if (packet.byteLength < 5 || packet.byteLength > MAX_RPC_PACKET_BYTES) {
    return false;
  }

  const rpcIndex = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  ).getUint32(1, true);
  return packet[0] === PacketIds.PACKET_RPC && rpcMaps[rpcIndex] !== undefined;
}
