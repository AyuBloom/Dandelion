import { ENGINE_PORT } from "../shared/config.ts";
import { feedback, logger } from "../shared/logger.ts";
import { Engine } from "./engine.ts";

export const engine = new Engine();

engine.listen(ENGINE_PORT);
logger.info(feedback.sessionSaverStarted, { port: ENGINE_PORT });

type StopSignal = "SIGINT" | "SIGTERM";

const signalExitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
} satisfies Record<StopSignal, number>;

let stopping = false;
const forceStop = (signal: StopSignal): void => {
  if (stopping) return;
  stopping = true;

  logger.warn(feedback.sessionSaverForceStopping, { signal });
  void Promise.resolve(engine.app.stop(true)).finally(() =>
    process.exit(signalExitCodes[signal]),
  );
};

process.once("SIGINT", () => forceStop("SIGINT"));
process.once("SIGTERM", () => forceStop("SIGTERM"));
