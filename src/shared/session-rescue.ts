import type { Socket } from "bun";

import type { SessionId } from "./ids.ts";

export const SESSION_RESCUE_DIRECTORY = ".session-rescue";

export interface SessionRescueSocketData {
  buffer: string;
}

export type SessionRescueFrame =
  | {
      type: "input";
      input: unknown;
    }
  | {
      type: "result";
      ok: boolean;
      error?: string;
    };

export function getSessionRescuePath(sessionId: SessionId): string {
  return `${process.cwd()}/${SESSION_RESCUE_DIRECTORY}/${sessionId}.sock`;
}

export function writeSessionRescueFrame(
  socket: Socket<SessionRescueSocketData>,
  frame: SessionRescueFrame,
): boolean {
  return socket.write(`${JSON.stringify(frame)}\n`) >= 0;
}

export function readSessionRescueFrames(
  buffer: string,
  data: Buffer,
  onFrame: (frame: SessionRescueFrame) => void,
): string {
  const chunks = `${buffer}${data.toString("utf8")}`.split("\n");
  const remaining = chunks.pop() ?? "";

  for (const chunk of chunks) {
    if (!chunk) continue;

    try {
      const frame = JSON.parse(chunk) as unknown;
      if (
        typeof frame === "object" &&
        frame !== null &&
        !Array.isArray(frame) &&
        ((frame as { type?: unknown }).type === "input" ||
          (frame as { type?: unknown }).type === "result")
      ) {
        onFrame(frame as SessionRescueFrame);
      }
    } catch {
      // Ignore malformed local frames without affecting the live session.
    }
  }

  return remaining;
}
