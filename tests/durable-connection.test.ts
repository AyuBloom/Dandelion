import { expect, test } from "bun:test";

import { DurableConnection } from "../src/durable-connection/connection.ts";
import { PacketIds } from "../src/network/enums.ts";
import MiniCodec from "../src/network/mini-codec.ts";
import type { DurableConnectionStatus, IpcMessage } from "../src/shared/ipc.ts";
import { parseListenerInput } from "../src/session/input.ts";

interface DurableConnectionTestHarness {
  codec: MiniCodec;
  status: DurableConnectionStatus;
  socket?: {
    readyState: number;
    send: (packet: ArrayBuffer | Uint8Array) => void;
  };
  handleSessionIPC(message: IpcMessage): void;
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
