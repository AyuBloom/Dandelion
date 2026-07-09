import { parseDebugLevel } from "./logger.ts";

export const ENGINE_PORT = process.env.API_PORT || 50000;
export const SESSIONS_CACHE_TTL_MS = Number(process.env.SESSIONS_CACHE_TTL_MS) || 30000;
export const DEBUG_LEVEL = parseDebugLevel(process.env.DEBUG_LEVEL);
