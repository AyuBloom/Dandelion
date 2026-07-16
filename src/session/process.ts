import { DandelionError, getErrorMessage } from "../shared/errors.ts";
import { logger } from "../shared/logger.ts";
import {
  AvailableAutomations,
  type AutomationId,
} from "../automations/automations.ts";
import { Session } from "./session.ts";

const getArg = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const readArgs = () => {
  const sessionId = getArg("--session-id");
  const sessionName = getArg("--session-name");
  const serverId = getArg("--server-id");
  const hostname = getArg("--hostname");
  const ipAddress = getArg("--ip-address");
  const portArg = getArg("--port");
  const psk = getArg("--psk");
  const eventPassword = getArg("--event-password");
  const automationsArg = getArg("--automations");

  if (!sessionId || !sessionName || !serverId || !hostname || !ipAddress) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Missing session args");
  }
  if (psk && !/^[a-zA-Z]{20}$/.test(psk)) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Invalid party share key");
  }

  const automations = automationsArg
    ? automationsArg.split(",").filter(Boolean)
    : [];
  if (
    automations.some(
      (id) => !AvailableAutomations.includes(id as AutomationId),
    )
  ) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Invalid automations");
  }

  const port = portArg ? Number(portArg) : undefined;
  if (port !== undefined && !Number.isInteger(port)) {
    throw new DandelionError("INVALID_PROCESS_ARGS", "Invalid server port");
  }

  return {
    sessionId,
    sessionName,
    serverId,
    hostname,
    ipAddress,
    port,
    psk,
    eventPassword,
    automations: automations as AutomationId[],
  };
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
