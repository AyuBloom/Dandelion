import { DurableConnection } from "./connection.ts";
import { DandelionError, getErrorMessage } from "../shared/errors.ts";
import { logger } from "../shared/logger.ts";

const getArg = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const readArgs = () => {
  const sessionId = getArg("--session-id") ;
  const durableConnectionId = getArg("--durable-id");
  const hostname = getArg("--hostname");
  const displayName = getArg("--display-name");

  if (!sessionId || !durableConnectionId || !hostname || !displayName) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Missing durable-connection args");
  }

  return { sessionId, durableConnectionId, hostname, displayName };
};

const main = async () => {
  const connection = new DurableConnection(readArgs());

  const shutdown = () => connection.close();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await connection.start();
};

void main().catch((error) => {
  logger.error("Durable connection process failed", getErrorMessage(error));
  process.exit(1);
});
