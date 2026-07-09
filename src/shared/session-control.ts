import type { Socket } from "bun";

import type { SessionId } from "./ids.ts";
import type { IpcMessage } from "./ipc.ts";

export const SESSION_CONTROL_DIRECTORY = ".session-control";

export type SessionControlSignal = "SIGINT" | "SIGTERM";

export interface SessionControlSocketData {
  buffer: string;
}

export type SessionControlFrame =
  | {
      type: "ipc";
      message: IpcMessage;
    }
  | {
      type: "terminate";
      signal: SessionControlSignal;
    };

export function getSessionControlPath(sessionId: SessionId): string {
  return `${process.cwd()}/${SESSION_CONTROL_DIRECTORY}/${sessionId}.sock`;
}

export function writeSessionControlFrame(
  socket: Socket<SessionControlSocketData>,
  frame: SessionControlFrame,
): boolean {
  return socket.write(`${JSON.stringify(frame, encodeBinary)}\n`) >= 0;
}

export function readSessionControlFrames(
  buffer: string,
  data: Buffer,
  onFrame: (frame: SessionControlFrame) => void,
): string {
  const chunks = `${buffer}${data.toString("utf8")}`.split("\n");
  const remaining = chunks.pop() ?? "";

  for (const chunk of chunks) {
    if (!chunk) continue;

    const frame = parseSessionControlFrame(chunk);
    if (frame) onFrame(frame);
  }

  return remaining;
}

function parseSessionControlFrame(line: string): SessionControlFrame | undefined {
  try {
    const frame = JSON.parse(line, decodeBinary);
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return undefined;
    }

    const record = frame as Record<string, unknown>;
    if (record.type === "ipc") {
      const message = record.message;
      if (
        typeof message !== "object" ||
        message === null ||
        Array.isArray(message) ||
        typeof (message as { type?: unknown }).type !== "string"
      ) {
        return undefined;
      }
      return { type: "ipc", message: message as IpcMessage };
    }

    if (record.type === "terminate") {
      return {
        type: "terminate",
        signal: record.signal === "SIGINT" ? "SIGINT" : "SIGTERM",
      };
    }
  } catch {
    return undefined;
  }
}

function encodeBinary(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __dandelionBinary: "Uint8Array",
      data: Buffer.from(value).toString("base64"),
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      __dandelionBinary: "ArrayBuffer",
      data: Buffer.from(value).toString("base64"),
    };
  }
  return value;
}

function decodeBinary(_key: string, value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { __dandelionBinary?: unknown }).__dandelionBinary !==
      "string" ||
    typeof (value as { data?: unknown }).data !== "string"
  ) {
    return value;
  }

  const record = value as {
    __dandelionBinary: string;
    data: string;
  };
  const bytes = Buffer.from(record.data, "base64");
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );

  return record.__dandelionBinary === "Uint8Array"
    ? new Uint8Array(arrayBuffer)
    : arrayBuffer;
}
