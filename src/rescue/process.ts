import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import type { Socket } from "bun";

import type { SessionHealth } from "../shared/ipc.ts";
import {
  getSessionRescuePath,
  readSessionRescueFrames,
  type SessionRescueFrame,
  type SessionRescueSocketData,
  writeSessionRescueFrame,
} from "../shared/session-rescue.ts";
import type { InputPacketData } from "../shared/packets.ts";

const help = `Commands:
  up|down|left|right|space [on|off]  Set a movement/action input
  respawn                            Send the native respawn input
  stop                               Release movement and space
  send {"up":1,"right":1}            Send raw input JSON
  help                               Show this help
  quit                               Release inputs and exit`;

const releasedInputs = {
  up: 0,
  down: 0,
  left: 0,
  right: 0,
  space: 0,
  mouseUp: 1,
} satisfies InputPacketData;

async function main(): Promise<void> {
  if (Bun.argv[2] === "--help" || Bun.argv[2] === "-h") {
    console.log(
      "Usage: bun run rescue [list|<session-id-or-name> [command]]\n\n" + help,
    );
    return;
  }

  const sessions = await readSessions();
  if (Bun.argv[2] === "list") {
    printSessions(sessions);
    return;
  }

  const target = await selectSession(sessions, Bun.argv[2]);
  const client = await connect(target);
  console.log(
    `Connected to ${target.sessionName} (${target.sessionId}) [${target.status}]`,
  );

  const oneShot = Bun.argv.slice(3).join(" ").trim();
  if (oneShot) {
    try {
      await client.send(parseCommand(oneShot));
      await Bun.sleep(100);
      await client.send(releasedInputs);
      console.log("Input accepted");
    } finally {
      client.close();
    }
    return;
  }

  console.log(help);
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let interrupted = false;
  let closed = false;
  readline.on("close", () => {
    closed = true;
  });
  readline.on("SIGINT", () => {
    interrupted = true;
    readline.close();
  });

  try {
    while (true) {
      let line: string;
      try {
        line = (await readline.question("rescue> ")).trim();
      } catch (error) {
        if (interrupted || closed) break;
        throw error;
      }
      if (!line) continue;
      if (line === "quit" || line === "exit") break;
      if (line === "help") {
        console.log(help);
        continue;
      }

      try {
        await client.send(parseCommand(line));
        console.log("Input accepted");
      } catch (error) {
        console.error(getErrorMessage(error));
      }
    }
  } finally {
    await client.send(releasedInputs).catch(() => undefined);
    readline.close();
    client.close();
  }
}

async function readSessions(): Promise<SessionHealth[]> {
  const files = await readdir(".sessions").catch(() => []);
  const sessions = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return JSON.parse(
            await readFile(`.sessions/${file}`, "utf8"),
          ) as SessionHealth;
        } catch {
          return undefined;
        }
      }),
  );

  return sessions
    .filter((session): session is SessionHealth => Boolean(session))
    .filter(({ status }) => status !== "closed" && status !== "failed")
    .sort((a, b) => a.sessionName.localeCompare(b.sessionName));
}

async function selectSession(
  sessions: SessionHealth[],
  requested?: string,
): Promise<SessionHealth> {
  if (sessions.length === 0) throw new Error("No running sessions found");

  if (requested) {
    const matches = sessions.filter(
      ({ sessionId, sessionName }) =>
        sessionId === requested ||
        sessionId.startsWith(requested) ||
        sessionName === requested,
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new Error(`No running session matches "${requested}"`);
    }
    throw new Error(`Session target "${requested}" is ambiguous`);
  }

  if (!process.stdin.isTTY) {
    throw new Error("Pass a session ID, ID prefix, or exact session name");
  }
  printSessions(sessions);

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const selection = Number(await readline.question("Session number: "));
    const session = sessions[selection - 1];
    if (!session) throw new Error("Invalid session number");
    return session;
  } finally {
    readline.close();
  }
}

function printSessions(sessions: SessionHealth[]): void {
  if (sessions.length === 0) {
    console.log("No running sessions found");
    return;
  }

  sessions.forEach((session, index) => {
    console.log(
      `${index + 1}. ${session.sessionName}  ${session.status}  ${session.sessionId}`,
    );
  });
}

async function connect(session: SessionHealth): Promise<{
  send(input: InputPacketData): Promise<void>;
  close(): void;
}> {
  let pending:
    | {
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;

  const socket = await Bun.connect<SessionRescueSocketData>({
    unix: getSessionRescuePath(session.sessionId),
    data: { buffer: "" },
    socket: {
      data: (connectedSocket, data) => {
        connectedSocket.data.buffer = readSessionRescueFrames(
          connectedSocket.data.buffer,
          data,
          (frame) => {
            if (frame.type !== "result" || !pending) return;
            const request = pending;
            pending = undefined;
            frame.ok
              ? request.resolve()
              : request.reject(new Error(frame.error ?? "Input rejected"));
          },
        );
      },
      close: () => {
        pending?.reject(new Error("Rescue connection closed"));
        pending = undefined;
      },
      error: (_, error) => {
        pending?.reject(error);
        pending = undefined;
      },
    },
  }).catch(() => {
    throw new Error(
      `Session rescue socket is unavailable for ${session.sessionId}. ` +
        "The session may have ended or was started before rescue support was installed.",
    );
  });

  return {
    send(input) {
      if (pending) {
        return Promise.reject(new Error("Another rescue input is pending"));
      }

      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        if (
          writeSessionRescueFrame(socket, {
            type: "input",
            input,
          })
        ) {
          return;
        }
        pending = undefined;
        reject(new Error("Failed to write rescue input"));
      });
    },
    close() {
      socket.end();
    },
  };
}

function parseCommand(line: string): InputPacketData {
  const raw = line.startsWith("send ") ? line.slice(5).trim() : line;
  if (raw.startsWith("{")) {
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Input JSON must be an object");
    }
    return input as InputPacketData;
  }

  if (raw === "stop") return releasedInputs;
  if (raw === "respawn") return { respawn: 1 };

  const [field, state = "on", extra] = raw.split(/\s+/);
  if (
    extra ||
    !field ||
    !["up", "down", "left", "right", "space"].includes(field) ||
    !["on", "off"].includes(state)
  ) {
    throw new Error("Unknown command. Type help for available commands.");
  }

  return {
    [field]: state === "on" ? 1 : 0,
  } as InputPacketData;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
});
