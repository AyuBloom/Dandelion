import { expect, test } from "bun:test";
import type { Socket } from "bun";

import type { IpcMessage } from "../src/shared/ipc.ts";
import {
  getSessionControlPath,
  readSessionControlFrames,
  SESSION_CONTROL_DIRECTORY,
  type SessionControlFrame,
  type SessionControlSocketData,
  writeSessionControlFrame,
} from "../src/shared/session-control.ts";

test("session control paths stay scoped to the current project", () => {
  expect(getSessionControlPath("session-123")).toBe(
    `${process.cwd()}/${SESSION_CONTROL_DIRECTORY}/session-123.sock`,
  );
});

test("session control frames survive fragmented binary round-trips", () => {
  const writes: string[] = [];
  const socket = {
    write(data: string) {
      writes.push(data);
      return data.length;
    },
  } as unknown as Socket<SessionControlSocketData>;
  const message = {
    type: "engine.input",
    from: "engine",
    to: "session",
    payload: new Uint8Array([3, 1, 2, 255]),
  } satisfies IpcMessage;

  expect(writeSessionControlFrame(socket, { type: "ipc", message })).toBeTrue();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.endsWith("\n")).toBeTrue();

  const splitAt = Math.floor(writes[0]!.length / 2);
  const frames: SessionControlFrame[] = [];
  const remaining = readSessionControlFrames(
    "",
    Buffer.from(writes[0]!.slice(0, splitAt)),
    (frame) => frames.push(frame),
  );

  expect(frames).toEqual([]);
  expect(remaining).not.toBe("");

  const finalRemaining = readSessionControlFrames(
    remaining,
    Buffer.from(writes[0]!.slice(splitAt)),
    (frame) => frames.push(frame),
  );

  expect(finalRemaining).toBe("");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.type).toBe("ipc");
  if (frames[0]?.type !== "ipc") throw new Error("Expected an IPC frame");
  expect(frames[0].message.type).toBe("engine.input");
  expect(frames[0].message.payload).toBeInstanceOf(Uint8Array);
  expect(Array.from(frames[0].message.payload as Uint8Array)).toEqual([
    3,
    1,
    2,
    255,
  ]);
});

test("session control parsing keeps valid frames and ignores malformed neighbors", () => {
  const packet = new Uint8Array([4, 8, 15, 16, 23, 42]).buffer;
  const writes: string[] = [];
  const socket = {
    write(data: string) {
      writes.push(data);
      return data.length;
    },
  } as unknown as Socket<SessionControlSocketData>;
  const message = {
    type: "durable.packet",
    from: "durable-connection",
    to: "session",
    payload: {
      sessionId: "session",
      data: packet,
    },
  } satisfies IpcMessage;

  expect(writeSessionControlFrame(socket, { type: "ipc", message })).toBeTrue();
  const validIpc = writes[0]!.trimEnd();
  const input = [
    "not json",
    JSON.stringify(null),
    JSON.stringify({ type: "ipc", message: { payload: {} } }),
    validIpc,
    JSON.stringify({ type: "terminate", signal: "SIGINT" }),
    JSON.stringify({ type: "terminate", signal: "unexpected" }),
    "",
  ].join("\n");
  const frames: SessionControlFrame[] = [];

  const remaining = readSessionControlFrames(
    "",
    Buffer.from(`${input}partial`),
    (frame) => frames.push(frame),
  );

  expect(remaining).toBe("partial");
  expect(frames).toHaveLength(3);
  expect(frames[1]).toEqual({ type: "terminate", signal: "SIGINT" });
  expect(frames[2]).toEqual({ type: "terminate", signal: "SIGTERM" });

  const ipc = frames[0];
  if (ipc?.type !== "ipc" || ipc.message.type !== "durable.packet") {
    throw new Error("Expected a durable packet frame");
  }
  expect(ipc.message.payload.data).toBeInstanceOf(ArrayBuffer);
  expect(Array.from(new Uint8Array(ipc.message.payload.data))).toEqual([
    4,
    8,
    15,
    16,
    23,
    42,
  ]);
});

test("session control writes report closed sockets", () => {
  const socket = {
    write: () => -1,
  } as unknown as Socket<SessionControlSocketData>;

  expect(
    writeSessionControlFrame(socket, { type: "terminate", signal: "SIGTERM" }),
  ).toBeFalse();
});
