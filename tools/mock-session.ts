import { getErrorMessage } from "../src/shared/errors.ts";
import { PacketIds } from "../src/network/enums.ts";
import MiniCodec from "../src/network/mini-codec.ts";
import { SolverWorker } from "../src/durable-connection/solver-worker.ts";
import { parseGameServerAddress } from "../src/shared/server-address.ts";
import type { EnterWorldData } from "../src/shared/packets.ts";

const opcodeNames: Partial<Record<PacketIds, string>> = {
  [PacketIds.PACKET_ENTITY_UPDATE]: "entity-update",
  [PacketIds.PACKET_ENTER_WORLD]: "enter-world",
  [PacketIds.PACKET_PRE_ENTER_WORLD]: "pre-enter-world",
  [PacketIds.PACKET_ENTER_WORLD2]: "enter-world-2",
  [PacketIds.PACKET_PING]: "ping",
  [PacketIds.PACKET_RPC]: "rpc",
  [PacketIds.PACKET_BLEND]: "blend",
};

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i++) {
  const arg = Bun.argv[i]!;
  if (!arg.startsWith("--")) continue;
  args.set(arg, Bun.argv[i + 1] ?? "");
  i++;
}

const serverId = args.get("--id");
const hostname = args.get("--hostname");
const ipAddress = args.get("--ip-address");
const displayName = args.get("--name") ?? `Dandelion${Math.floor(Math.random() * 1000)}`;
const maxMs = Number(args.get("--timeout-ms") ?? 15000);
const server = parseGameServerAddress({
  id: serverId,
  hostname,
  ipAddress,
});

if (!server) {
  console.error(
    "Usage: bun run tools/mock-session.ts --id v1007 --hostname zombs-2d4ca620-0.eggs.gg --ip-address 45.76.166.32",
  );
  process.exit(1);
}

const codec = new MiniCodec();
const solver = new SolverWorker(server.ipAddress);
let socket: WebSocket | undefined;
let closed = false;
let reachedWorld = false;

const finish = (code: number, reason: string) => {
  if (closed) return;
  closed = true;
  clearTimeout(timeout);
  console.log(reason);
  socket?.close();
  solver.close();
  process.exit(code);
};

const timeout = setTimeout(() => {
  finish(reachedWorld ? 0 : 1, "Mock session timed out");
}, maxMs);

function logPacket(direction: "in" | "out", opcode: PacketIds, bytes: number): void {
  console.log(`${direction} ${opcode} ${opcodeNames[opcode] ?? "unknown"} ${bytes}b`);
}

function send(packet: ArrayBuffer | Uint8Array): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(packet);
}

function sendRaw(opcode: PacketIds, payload: Uint8Array): void {
  const packet = new Uint8Array(1 + payload.byteLength);
  packet[0] = opcode;
  packet.set(payload, 1);
  logPacket("out", opcode, packet.byteLength);
  send(packet);
}

function sendPacket(opcode: PacketIds, payload: Parameters<MiniCodec["encode"]>[1]): void {
  const packet = codec.encode(opcode, payload);
  logPacket("out", opcode, packet.byteLength);
  send(packet);
}

try {
  await solver.waitUntilReady();

  console.log(
    `Connecting to ${server.hostname}:${server.port} with solver ip ${server.ipAddress}`,
  );
  const websocketUrl = `wss://${server.hostname}:${server.port}`;
  socket = new WebSocket(websocketUrl, {
    headers: {
      Origin: "",
      "User-Agent": "",
    },
  });
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    console.log("WebSocket open");
    sendPacket(PacketIds.PACKET_PING, {});
  };

  socket.onerror = () => {
    finish(1, "WebSocket error");
  };

  socket.onclose = () => {
    finish(reachedWorld ? 0 : 1, reachedWorld ? "Mock session closed after enter-world" : "Server closed before enter-world");
  };

  socket.onmessage = (event) => {
    void (async () => {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const opcode = bytes[0] as PacketIds;
      logPacket("in", opcode, bytes.byteLength);

      switch (opcode) {
        case PacketIds.PACKET_PRE_ENTER_WORLD: {
          const extra = await solver.solvePreEnter(bytes.subarray(1));
          sendPacket(PacketIds.PACKET_ENTER_WORLD, { displayName, extra });
          break;
        }
        case PacketIds.PACKET_ENTER_WORLD: {
          const packet = codec.decode(bytes) as EnterWorldData;
          if (!packet.allowed) {
            finish(1, "Server rejected enter-world");
            return;
          }

          const extra = await solver.enterWorld2();
          sendRaw(PacketIds.PACKET_ENTER_WORLD2, extra);
          reachedWorld = true;
          finish(0, "Entered world successfully");
          break;
        }
        case PacketIds.PACKET_BLEND: {
          const extra = await solver.solveBlend(bytes.subarray(1));
          sendRaw(PacketIds.PACKET_BLEND, new Uint8Array(extra));
          break;
        }
        case PacketIds.PACKET_PING:
          break;
        default:
          break;
      }
    })().catch((error) => {
      finish(1, `Mock session failed: ${getErrorMessage(error)}`);
    });
  };
} catch (error) {
  finish(1, `Mock session failed: ${getErrorMessage(error)}`);
}
