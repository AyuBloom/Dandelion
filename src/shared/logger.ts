const RESET = "\x1b[0m";

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";

const logColors = {
  debug: "\x1b[38;2;255;154;170m",
  error: "\x1b[38;2;159;0;31m",
  info: "\x1b[38;2;255;107;128m",
  log: "\x1b[38;2;255;23;68m",
  warn: "\x1b[38;2;216;23;61m",
} satisfies Record<ConsoleMethod, string>;

const writeLog = (method: ConsoleMethod, values: unknown[]) => {
  console[method](`${logColors[method]}[${method}]${RESET}`, ...values);
};

export const logger = {
  debug: (...values: unknown[]) => writeLog("debug", values),
  error: (...values: unknown[]) => writeLog("error", values),
  info: (...values: unknown[]) => writeLog("info", values),
  log: (...values: unknown[]) => writeLog("log", values),
  warn: (...values: unknown[]) => writeLog("warn", values),
} as const;
