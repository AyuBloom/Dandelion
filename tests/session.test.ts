import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import MiniCodec from "../src/network/mini-codec.ts";
import { ServerCodec } from "../src/network/server-codec.ts";
import { PacketIds, ParameterType } from "../src/network/enums.ts";
import type {
  DurableConnectionStatus,
  IpcMessage,
  SyncData,
} from "../src/shared/ipc.ts";
import type {
  EntityData,
  EnterWorldData,
  RpcData,
  RpcMapEntry,
  RpcObject,
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
  serverCodec: ServerCodec;
  enterWorld?: EnterWorldData;
  latestTick?: number;
  singleRpcPackets: Record<string, ArrayBuffer>;
  buildingSchema: Readonly<Record<string, unknown>>;
  localBuildingsByUid: Map<number, RpcObject>;
  entitySnapshot: Map<number, EntityData>;
  automationManager: {
    context: {
      readSessionState(): Readonly<Record<string, unknown>>;
    };
  };
  chatPackets: ArrayBuffer[];
  virtualInventory: Map<string, Record<string, number | string>>;
  synthesizeSyncPackets(): SyncData | undefined;
  synthesizeRpcPackets(): ArrayBuffer[];
  handleEngineIPC(message: IpcMessage): void;
  forwardDurablePacket(data: ArrayBuffer): void;
  recordRpcPacket(packet: RpcData, data: ArrayBuffer): void;
  sendConfiguredPsk(): void;
}

test("session parses BuildingShopPrices for automations while retaining sync data", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  const schema = {
    Wall: {
      woodCosts: [0, 10],
      stoneCosts: [0, 5],
      goldCosts: [0, 0],
    },
  };
  const data = packet(17);

  session.recordRpcPacket(
    {
      name: "BuildingShopPrices",
      response: { json: JSON.stringify(schema) },
    },
    data,
  );

  expect(session.buildingSchema).toEqual(schema);
  expect(new Uint8Array(session.singleRpcPackets.BuildingShopPrices!)).toEqual(
    new Uint8Array(data),
  );
});

test("session keeps the last valid building schema after malformed updates", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  const schema = {
    Wall: {
      woodCosts: [0, 10],
      stoneCosts: [0, 5],
      goldCosts: [0, 0],
    },
  };

  session.recordRpcPacket(
    {
      name: "BuildingShopPrices",
      response: { json: JSON.stringify(schema) },
    },
    packet(17),
  );
  session.recordRpcPacket(
    {
      name: "BuildingShopPrices",
      response: { json: "[\"not\",\"a\",\"schema\"]" },
    },
    packet(17),
  );
  session.recordRpcPacket(
    {
      name: "BuildingShopPrices",
      response: { json: "{invalid json" },
    },
    packet(17),
  );

  expect(session.buildingSchema).toEqual(schema);
});

test("session exposes owned buildings with entity yaw to automations", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  session.localBuildingsByUid.set(10, {
    uid: 10,
    type: "MeleeTower",
    x: 48,
    y: 96,
    tier: 4,
    dead: 0,
  });
  session.entitySnapshot.set(10, { uid: 10, yaw: 270 });

  const state = session.automationManager.context.readSessionState();

  expect(state.buildings).toEqual([
    {
      uid: 10,
      type: "MeleeTower",
      x: 48,
      y: 96,
      tier: 4,
      dead: 0,
      yaw: 270,
    },
  ]);
});

test("session health uses the Engine-provided identity and name", () => {
  const session = new Session({
    sessionId: "session-id",
    sessionName: "test-session",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;

  expect(session.health.sessionId).toBe("session-id");
  expect(session.health.sessionName).toBe("test-session");
});

test("session automation IPC returns defaults, applies settings immediately, and correlates responses", async () => {
  const sessionId = crypto.randomUUID();
  const session = new Session({
    sessionId,
    sessionName: "automation-test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  const sent: IpcMessage[] = [];
  const parent = process as unknown as {
    send?: (message: unknown) => boolean;
  };
  const previousSend = parent.send;
  parent.send = (message) => {
    sent.push(message as IpcMessage);
    return true;
  };

  try {
    session.handleEngineIPC({
      type: "engine.automations.get",
      from: "engine",
      to: "session",
      payload: { sessionId: crypto.randomUUID(), requestId: "wrong-session" },
    });
    expect(sent).toEqual([]);

    session.handleEngineIPC({
      type: "engine.automations.get",
      from: "engine",
      to: "session",
      payload: { sessionId, requestId: "get-defaults" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "session.automations",
      payload: {
        sessionId,
        requestId: "get-defaults",
        automations: [
          {
            id: "ahrc",
            enabled: false,
            status: "disabled",
            settings: { collect: true, harvest: true },
          },
          {
            id: "autoAim",
            enabled: false,
            status: "disabled",
            settings: { players: true, zombies: true, npcs: true },
          },
          {
            id: "autoBow",
            enabled: false,
            status: "disabled",
            settings: {},
          },
          {
            id: "autoRebuilder",
            enabled: false,
            status: "disabled",
            settings: {},
          },
          {
            id: "autoUpgrader",
            enabled: false,
            status: "disabled",
            settings: {},
          },
          {
            id: "aulht",
            enabled: false,
            status: "disabled",
            settings: {},
          },
        ],
      },
    });

    session.handleEngineIPC({
      type: "engine.automation.update",
      from: "engine",
      to: "session",
      payload: {
        sessionId,
        requestId: "update-auto-aim",
        automationId: "autoAim",
        update: { enabled: true, settings: { players: false } },
      },
    });
    await waitForMessages(sent, 2);
    expect(sent[1]).toMatchObject({
      type: "session.automations",
      payload: {
        sessionId,
        requestId: "update-auto-aim",
        automations: [
          {},
          {
            id: "autoAim",
            enabled: true,
            status: "running",
            settings: { players: false, zombies: true, npcs: true },
          },
          {},
          {},
          {},
          {},
        ],
      },
    });

    session.handleEngineIPC({
      type: "engine.automation.update",
      from: "engine",
      to: "session",
      payload: {
        sessionId,
        requestId: "invalid-update",
        automationId: "autoAim",
        update: { settings: { buildings: true } },
      },
    });
    await waitForMessages(sent, 3);
    expect(sent[2]).toMatchObject({
      type: "session.automations.error",
      payload: {
        sessionId,
        requestId: "invalid-update",
        error: "Invalid autoAim setting: buildings",
      },
    });
  } finally {
    if (previousSend) parent.send = previousSend;
    else delete parent.send;
    await rm(`.session-automations/${sessionId}.json`, { force: true });
  }
});

test("session applies the minimal listener input guards", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
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

  const relaxedInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, {
      up: 2,
      mouseUp: 0,
      worldX: 1.5,
      distance: -1,
    }),
  );
  session.handleEngineIPC(engineInput(relaxedInput));
  session.handleEngineIPC(
    engineInput(
      new Uint8Array(
        codec.encode(PacketIds.PACKET_INPUT, { mouseMoved: 180.5 }),
      ),
    ),
  );
  expect(sent).toHaveLength(3);

  session.handleEngineIPC(
    engineInput(
      new Uint8Array(
        codec.encode(PacketIds.PACKET_INPUT, { unknown: 1 } as never),
      ),
    ),
  );
  session.handleEngineIPC(
    engineInput(
      new Uint8Array(
        codec.encode(PacketIds.PACKET_INPUT, { mouseMoved: 360 }),
      ),
    ),
  );
  session.handleEngineIPC(
    engineInput(new Uint8Array(codec.encode(PacketIds.PACKET_INPUT, {}))),
  );
  session.handleEngineIPC(engineInput(Uint8Array.of(PacketIds.PACKET_INPUT)));
  expect(sent).toHaveLength(3);

  session.health.status = "waiting-enter-world";
  session.handleEngineIPC(engineInput(validInput));
  expect(sent).toHaveLength(3);
});

test("synthesized sync data carries one consistent snapshot tick", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
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

test("session passes mapped listener RPCs up to 256 bytes", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
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

  const mappedWithUncheckedPayload = Uint8Array.of(
    PacketIds.PACKET_RPC,
    0,
    0,
    0,
    0,
    255,
  );
  session.handleEngineIPC(engineRpc(mappedWithUncheckedPayload));

  session.handleEngineIPC(
    engineRpc(Uint8Array.of(PacketIds.PACKET_RPC, 1, 0, 0, 0)),
  );

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
    {
      type: "session.rpc",
      from: "session",
      to: "durable-connection",
      payload: mappedWithUncheckedPayload,
    },
  ]);
});

test("session forwards respawn input", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  const sent: unknown[] = [];
  const codec = new MiniCodec();
  session.health.status = "in-world";
  session.durableConnection = { send: (message) => sent.push(message) };

  const respawn = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { respawn: 1 }),
  );
  session.handleEngineIPC(engineInput(respawn));
  session.handleEngineIPC(
    engineInput(
      new Uint8Array(codec.encode(PacketIds.PACKET_INPUT, { respawn: 0 })),
    ),
  );

  expect(sent).toEqual([
    {
      type: "session.input",
      from: "session",
      to: "durable-connection",
      payload: { respawn: 1 },
    },
  ]);
});

test("session sends a configured party share key once", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
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
    ...serverAddress(),
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

test("session sync reconstructs the current player inventory from SetItem", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  const setItemRpc: RpcMapEntry = {
    name: "SetItem",
    parameters: [
      { name: "itemName", type: ParameterType.String },
      { name: "tier", type: ParameterType.Uint32 },
      { name: "stacks", type: ParameterType.Uint32 },
    ],
    isArray: false,
    index: 0,
  };
  session.serverCodec.state.rpcMaps = [setItemRpc];

  session.recordRpcPacket(
    {
      name: "SetItem",
      response: { itemName: "Pickaxe", tier: 2, stacks: 1 },
    },
    packet(1),
  );
  session.recordRpcPacket(
    {
      name: "SetItem",
      response: { itemName: "HealthPotion", tier: 1, stacks: 3 },
    },
    packet(2),
  );
  session.recordRpcPacket(
    {
      name: "SetItem",
      response: { itemName: "HealthPotion", tier: 1, stacks: 0 },
    },
    packet(3),
  );

  const decoder = new MiniCodec();
  configureRpc(decoder, setItemRpc);
  expect(
    session.synthesizeRpcPackets().map((rpc) => decoder.decode(rpc)),
  ).toEqual([
    {
      opcode: PacketIds.PACKET_RPC,
      name: "SetItem",
      response: { itemName: "Pickaxe", tier: 2, stacks: 1 },
    },
  ]);
  expect(session.virtualInventory.has("HealthPotion")).toBeFalse();
});

test("entity ticks are read without decoding the entity payload", () => {
  const packet = Uint8Array.of(PacketIds.PACKET_ENTITY_UPDATE, 0x78, 0x56, 0x34, 0x12);
  expect(readEntityTick(packet.buffer)).toBe(0x12345678);
});

test("session drops pre-enter handshake packets before engine forwarding", () => {
  const session = new Session({
    sessionId: "session",
    sessionName: "test",
    ...serverAddress(),
  }) as unknown as SessionTestHarness;
  const sent: unknown[] = [];
  const parent = process as unknown as {
    send?: (message: unknown) => boolean;
  };
  const previousSend = parent.send;

  parent.send = (message) => {
    sent.push(message);
    return true;
  };

  try {
    session.forwardDurablePacket(
      Uint8Array.of(PacketIds.PACKET_PRE_ENTER_WORLD, 1, 2, 3).buffer,
    );
  } finally {
    if (previousSend) parent.send = previousSend;
    else delete parent.send;
  }

  expect(sent).toEqual([]);
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

function serverAddress() {
  return {
    serverId: "v1007",
    hostname: "zombs-2d4ca620-0.eggs.gg",
    ipAddress: "45.76.166.32",
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

async function waitForMessages(
  messages: readonly unknown[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (messages.length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${count} IPC messages`);
}
