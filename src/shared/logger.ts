const RESET = "\x1b[0m";

type ConsoleMethod = "debug" | "error" | "info" | "log" | "warn";
export const DEBUG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type DebugLevel = (typeof DEBUG_LEVELS)[number];

export const parseDebugLevel = (value: string | undefined): DebugLevel => {
  const normalized = value?.trim().toLowerCase();
  if (DEBUG_LEVELS.includes(normalized as DebugLevel)) {
    return normalized as DebugLevel;
  }
  return "info";
};

const activeDebugLevel = parseDebugLevel(process.env.DEBUG_LEVEL);
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
let discordDelivery = Promise.resolve();

const logColors = {
  debug: "\x1b[38;2;255;154;170m",
  error: "\x1b[38;2;159;0;31m",
  info: "\x1b[38;2;255;107;128m",
  log: "\x1b[38;2;255;23;68m",
  warn: "\x1b[38;2;216;23;61m",
} satisfies Record<ConsoleMethod, string>;

const levelPriority = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
} satisfies Record<DebugLevel, number>;

const methodLevel = {
  debug: "debug",
  error: "error",
  info: "info",
  log: "info",
  warn: "warn",
} satisfies Record<ConsoleMethod, Exclude<DebugLevel, "silent">>;

const shouldWriteLog = (method: ConsoleMethod) =>
  levelPriority[methodLevel[method]] >= levelPriority[activeDebugLevel];

const formatLogValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const forwardLog = (method: ConsoleMethod, values: unknown[]) => {
  if (!discordWebhookUrl) return;

  const content = `[${method}] ${values.map(formatLogValue).join(" ")}`.slice(0, 2000);
  discordDelivery = discordDelivery
    .then(async () => {
      const response = await fetch(discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      if (!response.ok) {
        console.error(`Discord webhook rejected a log message (${response.status})`);
      }
    })
    .catch((error) => console.error("Discord webhook delivery failed", error));
};

const writeLog = (method: ConsoleMethod, values: unknown[]) => {
  if (!shouldWriteLog(method)) return;
  console[method](`${logColors[method]}[${method}]${RESET}`, ...values);
  forwardLog(method, values);
};

export const feedback = {
  existingSessionReattached:
    "(^o^)/ Dandelion found an existing session and reattached it.",
  listenerAttached: "(o^ ^o) A listener attached and is syncing gently.",
  listenerDetached: "(u_u) A listener detached. Waving bye-bye.",
  sessionSaverStarted:
    "(o^ ^o) Dandelion is awake. Session Saver is listening.",
  sessionSaverForceStopping:
    "(>_<) Dandelion is being force-stopped. Tucking things in now.",
  sessionStarted: "(*^ ^*) A session sprouted and is being kept cozy.",
  sessionStopped: "(u_u) Session stopped and got tucked in safely.",
} as const;

export const logger = {
  debug: (...values: unknown[]) => writeLog("debug", values),
  error: (...values: unknown[]) => writeLog("error", values),
  info: (...values: unknown[]) => writeLog("info", values),
  log: (...values: unknown[]) => writeLog("log", values),
  warn: (...values: unknown[]) => writeLog("warn", values),
} as const;
