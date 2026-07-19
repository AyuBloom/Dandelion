import { expect, test } from "bun:test";
import type { Socket } from "bun";

import {
  getSessionRescuePath,
  readSessionRescueFrames,
  SESSION_RESCUE_DIRECTORY,
  type SessionRescueFrame,
  type SessionRescueSocketData,
  writeSessionRescueFrame,
} from "../src/shared/session-rescue.ts";

test("session rescue paths stay scoped to the current project", () => {
  expect(getSessionRescuePath("session-123")).toBe(
    `${process.cwd()}/${SESSION_RESCUE_DIRECTORY}/session-123.sock`,
  );
});

test("session rescue frames survive fragmentation and malformed neighbors", () => {
  const writes: string[] = [];
  const socket = {
    write(data: string) {
      writes.push(data);
      return data.length;
    },
  } as unknown as Socket<SessionRescueSocketData>;

  expect(
    writeSessionRescueFrame(socket, {
      type: "input",
      input: { up: 1, right: 1 },
    }),
  ).toBeTrue();

  const serialized = writes[0]!;
  const splitAt = Math.floor(serialized.length / 2);
  const frames: SessionRescueFrame[] = [];
  let remaining = readSessionRescueFrames(
    "",
    Buffer.from(`not json\n${serialized.slice(0, splitAt)}`),
    (frame) => frames.push(frame),
  );

  expect(frames).toEqual([]);
  remaining = readSessionRescueFrames(
    remaining,
    Buffer.from(serialized.slice(splitAt)),
    (frame) => frames.push(frame),
  );

  expect(remaining).toBe("");
  expect(frames).toEqual([
    {
      type: "input",
      input: { up: 1, right: 1 },
    },
  ]);
});

test("session rescue writes report closed sockets", () => {
  const socket = {
    write: () => -1,
  } as unknown as Socket<SessionRescueSocketData>;

  expect(
    writeSessionRescueFrame(socket, {
      type: "result",
      ok: false,
      error: "closed",
    }),
  ).toBeFalse();
});
