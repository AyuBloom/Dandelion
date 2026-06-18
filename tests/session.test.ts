import { expect, test } from "bun:test";

import MiniCodec from "../src/network/mini-codec.ts";
import { PacketIds, ParameterType } from "../src/network/enums.ts";
import type {
  DurableConnectionStatus,
  IpcMessage,
  SyncData,
} from "../src/shared/ipc.ts";
import type {
  EnterWorldData,
  RpcData,
  RpcMapEntry,
} from "../src/shared/packets.ts";
import { readEntityTick, Session } from "../src/session/session.ts";

interface SessionTestHarness {
  health: {
    status: DurableConnectionStatus;
    sessionId: string;
    sessionName: string;
  };
  durableConnection?: { send: (message: unknown) => void };
  clientCodec: MiniCodec;
  enterWorld?: EnterWorldData;
  latestTick?: number;
  singleRpcPackets: Record<string, ArrayBuffer>;
  chatPackets: ArrayBuffer[];
  synthesizeSyncPackets(): SyncData | undefined;
  handleEngineIPC(message: IpcMessage): void;
  recordRpcPacket(packet: RpcData, data: ArrayBuffer): void;
  sendConfiguredPsk(): void;
}

test("session health uses the Engine-provided identity and name", () => {
  const session = new Session({
    sessionId: "session-id",
    sessionName: "test-session",
    server: "127.0.0.1",
  }) as unknown as SessionTestHarness;

  expect(session.health.sessionId).toBe("session-id");
  expect(session.health.sessionName).toBe("test-session");
});

test("session validates listener inputs before forwarding them", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    server: "127.0.0.1",
  }) as unknown as SessionTestHarness;
  const sent: unknown[] = [];
  const codec = new MiniCodec();

  session.health.status = "in-world";
  session.durableConnection = { send: (message) => sent.push(message) };

  const validInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { up: 1 }),
  );
  session.handleEngineIPC(engineInput(validInput));

  expect(sent).toEqual([
    {
      type: "session.input",
      from: "session",
      to: "durable-connection",
      payload: { up: 1 },
    },
  ]);

  const invalidInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { up: 2 }),
  );
  session.handleEngineIPC(engineInput(invalidInput));
  session.handleEngineIPC(engineInput(Uint8Array.of(PacketIds.PACKET_INPUT)));
  expect(sent).toHaveLength(1);

  session.health.status = "waiting-enter-world";
  session.handleEngineIPC(engineInput(validInput));
  expect(sent).toHaveLength(1);
});

test("synthesized sync data carries one consistent snapshot tick", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    server: "127.0.0.1",
  }) as unknown as SessionTestHarness;

  session.enterWorld = enterWorldData();
  session.latestTick = 42;
  session.singleRpcPackets.PartyInfo = packet(1);
  session.singleRpcPackets.DayCycle = packet(2);
  session.chatPackets.push(packet(3));

  const sync = session.synthesizeSyncPackets();
  expect(sync).toBeDefined();
  if (!sync) return;

  const decoder = new MiniCodec();
  const enterWorld = decoder.decode(sync.enterWorldPacket) as EnterWorldData;
  const entityUpdate = decoder.decode(sync.freshEntityUpdatePacket);

  expect(sync.snapshotTick).toBe(42);
  expect(enterWorld.startingTick).toBe(42);
  expect("tick" in entityUpdate ? entityUpdate.tick : undefined).toBe(42);
  expect(sync.rpcPackets.map((rpc) => new Uint8Array(rpc)[0])).toEqual([
    1, 2, 3,
  ]);
});

test("session validates listener RPCs against the live schema", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    server: "127.0.0.1",
  }) as unknown as SessionTestHarness;
  const sent: unknown[] = [];
  const rpc = rpcMap("SendChatMessage", "message");
  configureRpc(session.clientCodec, rpc);
  session.health.status = "in-world";
  session.durableConnection = { send: (message) => sent.push(message) };

  const valid = new Uint8Array(
    session.clientCodec.encode(PacketIds.PACKET_RPC, {
      name: rpc.name,
      message: "hello",
    }),
  );
  session.handleEngineIPC(engineRpc(valid));

  const oversized = new Uint8Array(
    session.clientCodec.encode(PacketIds.PACKET_RPC, {
      name: rpc.name,
      message: "x".repeat(300),
    }),
  );
  session.handleEngineIPC(engineRpc(oversized));

  expect(sent).toEqual([
    {
      type: "session.rpc",
      from: "session",
      to: "durable-connection",
      payload: valid,
    },
  ]);
});

test("session sends a configured party share key once", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    server: "127.0.0.1",
    psk: "abcdefghijklmnopqrst",
  }) as unknown as SessionTestHarness;
  const sent: unknown[] = [];
  const rpc = rpcMap("JoinPartyByShareKey", "partyShareKey");
  configureRpc(session.clientCodec, rpc);
  session.health.status = "in-world";
  session.durableConnection = { send: (message) => sent.push(message) };

  session.sendConfiguredPsk();
  session.sendConfiguredPsk();

  const expected = new Uint8Array(
    session.clientCodec.encode(PacketIds.PACKET_RPC, {
      name: rpc.name,
      partyShareKey: "abcdefghijklmnopqrst",
    }),
  );
  expect(sent).toEqual([
    {
      type: "session.rpc",
      from: "session",
      to: "durable-connection",
      payload: expected,
    },
  ]);
});

test("session caps chat history at 500 messages", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    server: "127.0.0.1",
  }) as unknown as SessionTestHarness;

  for (let marker = 0; marker < 501; marker++) {
    session.recordRpcPacket(
      { name: "ReceiveChatMessage", response: {} },
      Uint8Array.of(marker & 0xff).buffer,
    );
  }

  expect(session.chatPackets).toHaveLength(500);
  expect(new Uint8Array(session.chatPackets[0]!)[0]).toBe(1);
});

test("entity ticks are read without decoding the entity payload", () => {
  const packet = Uint8Array.of(PacketIds.PACKET_ENTITY_UPDATE, 0x78, 0x56, 0x34, 0x12);
  expect(readEntityTick(packet.buffer)).toBe(0x12345678);
});

function enterWorldData(): EnterWorldData {
  return {
    allowed: 1,
    uid: 7,
    startingTick: 1,
    tickRate: 20,
    effectiveTickRate: 20,
    players: 1,
    maxPlayers: 32,
    chatChannel: 0,
    effectiveDisplayName: "test",
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 100,
  };
}

function packet(marker: number): ArrayBuffer {
  return Uint8Array.of(marker).buffer;
}

function engineInput(payload: Uint8Array): IpcMessage {
  return {
    type: "engine.input",
    from: "engine",
    to: "session",
    payload,
  };
}

function engineRpc(payload: Uint8Array): IpcMessage {
  return {
    type: "engine.rpc",
    from: "engine",
    to: "session",
    payload,
  };
}

function rpcMap(name: string, parameterName: string): RpcMapEntry {
  return {
    name,
    parameters: [{ name: parameterName, type: ParameterType.String }],
    isArray: false,
    index: 0,
  };
}

function configureRpc(codec: MiniCodec, rpc: RpcMapEntry): void {
  codec.rpcMaps = [rpc];
  codec.rpcMapsByName = { [rpc.name]: rpc };
}
