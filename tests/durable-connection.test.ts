import { expect, test } from "bun:test";

import { DurableConnection } from "../src/durable-connection/connection.ts";
import { PacketIds } from "../src/network/enums.ts";
import MiniCodec from "../src/network/mini-codec.ts";
import { ServerCodec } from "../src/network/server-codec.ts";
import type { DurableConnectionStatus, IpcMessage } from "../src/shared/ipc.ts";
import type { EnterWorldData } from "../src/shared/packets.ts";
import { parseListenerInput } from "../src/session/input.ts";

interface DurableConnectionTestHarness {
  codec: MiniCodec;
  status: DurableConnectionStatus;
  socket?: {
    readyState: number;
    send: (packet: ArrayBuffer | Uint8Array) => void;
  };
  solver?: { enterWorld2: () => Promise<Uint8Array> };
  options?: {
    sessionId: string;
    durableConnectionId: string;
    serverId: string;
    hostname: string;
    ipAddress: string;
  };
  handleSessionIPC(message: IpcMessage): void;
  handleMessageData(data: ArrayBuffer): Promise<void>;
  sendPing(): void;
  startKeepalive(): void;
}

test("durable connection sends validated session inputs to the socket", () => {
  const connection = Object.create(
    DurableConnection.prototype,
  ) as DurableConnectionTestHarness;
  const sent: ArrayBuffer[] = [];

  connection.codec = new MiniCodec();
  connection.status = "in-world";
  connection.socket = {
    readyState: WebSocket.OPEN,
    send: (packet) => sent.push(copyBuffer(packet)),
  };

  connection.handleSessionIPC(sessionInput({ left: 1 }));

  expect(sent).toHaveLength(1);
  expect(parseListenerInput(new Uint8Array(sent[0]!))).toEqual({ left: 1 });
});

test("durable connection ignores inputs until it is in world", () => {
  const connection = Object.create(
    DurableConnection.prototype,
  ) as DurableConnectionTestHarness;
  const sent: ArrayBuffer[] = [];

  connection.codec = new MiniCodec();
  connection.status = "waiting-enter-world";
  connection.socket = {
    readyState: WebSocket.OPEN,
    send: (packet) => sent.push(copyBuffer(packet)),
  };

  connection.handleSessionIPC(sessionInput({ right: 1 }));
  expect(sent).toEqual([]);
});

test("durable connection forwards only bounded RPC packets", () => {
  const connection = Object.create(
    DurableConnection.prototype,
  ) as DurableConnectionTestHarness;
  const sent: ArrayBuffer[] = [];

  connection.codec = new MiniCodec();
  connection.status = "in-world";
  connection.socket = {
    readyState: WebSocket.OPEN,
    send: (packet) => sent.push(copyBuffer(packet)),
  };

  const rpc = Uint8Array.of(PacketIds.PACKET_RPC, 0, 0, 0, 0);
  connection.handleSessionIPC(sessionRpc(rpc));
  connection.handleSessionIPC(sessionRpc(new Uint8Array(257)));
  connection.handleSessionIPC(sessionRpc(Uint8Array.of(PacketIds.PACKET_INPUT)));

  expect(sent).toEqual([rpc.buffer]);
});

test("durable connection publishes enter-world before in-world status", async () => {
  const connection = Object.create(
    DurableConnection.prototype,
  ) as DurableConnectionTestHarness;
  const sent: IpcMessage[] = [];
  const packet = new ServerCodec().encodeEnterWorldResponse(enterWorldData());
  const parent = process as unknown as {
    send?: (message: unknown) => boolean;
  };
  const previousSend = parent.send;

  connection.codec = new MiniCodec();
  connection.status = "waiting-enter-world";
  connection.options = {
    sessionId: "session",
    durableConnectionId: "durable",
    serverId: "v1",
    hostname: "example.com",
    ipAddress: "127.0.0.1",
  };
  connection.solver = {
    enterWorld2: async () => new Uint8Array(),
  };
  connection.socket = {
    readyState: WebSocket.OPEN,
    send: () => {},
  };
  connection.sendPing = () => {};
  connection.startKeepalive = () => {};
  parent.send = (message) => {
    sent.push(message as IpcMessage);
    return true;
  };

  try {
    await connection.handleMessageData(packet);
  } finally {
    if (previousSend) parent.send = previousSend;
    else delete parent.send;
  }

  expect(sent.map((message) => message.type)).toEqual([
    "durable.packet",
    "durable.status",
  ]);
  expect(sent[0]?.payload).toEqual({
    data: packet,
    sessionId: "session",
  });
  expect(sent[1]?.payload).toMatchObject({
    sessionId: "session",
    status: "in-world",
  });
});

function sessionInput(payload: { left?: number; right?: number }): IpcMessage {
  return {
    type: "session.input",
    from: "session",
    to: "durable-connection",
    payload,
  };
}

function sessionRpc(payload: Uint8Array): IpcMessage {
  return {
    type: "session.rpc",
    from: "session",
    to: "durable-connection",
    payload,
  };
}

function copyBuffer(packet: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (packet instanceof Uint8Array) return packet.slice().buffer;
  return packet.slice(0);
}

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
