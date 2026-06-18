import { DandelionError, getErrorMessage } from "../shared/errors.ts";
import { logger } from "../shared/logger.ts";
import { Session } from "./session.ts";

const getArg = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const readArgs = () => {
  const sessionId = getArg("--session-id");
  const sessionName = getArg("--session-name");
  const server = getArg("--server");
  const psk = getArg("--psk");

  if (!sessionId || !sessionName || !server) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Missing session args");
  }
  if (psk && !/^[a-zA-Z]{20}$/.test(psk)) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Invalid party share key");
  }

  return { sessionId, sessionName, server, psk };
};

const main = async () => {
  const session = new Session(readArgs());
  const exitCode = await session.start();
  process.exit(exitCode);
};

void main().catch((error) => {
  logger.error("Session process failed", getErrorMessage(error));
  process.exit(1);
});
