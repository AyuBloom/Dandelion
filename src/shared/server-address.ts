import { isIP } from "node:net";

export interface GameServerAddress {
  id: string;
  hostname: string;
  ipAddress: string;
  port: 443;
}

export interface GameServerAddressInput {
  id: unknown;
  hostname: unknown;
  ipAddress: unknown;
}

const SERVER_ID_PATTERN = /^v\d{4}$/;
const SERVER_HOSTNAME_PATTERN = /^zombs-[a-z0-9]+-0\.eggs\.gg$/;

export function parseGameServerAddress(
  input: GameServerAddressInput,
): GameServerAddress | undefined {
  if (typeof input.id !== "string" || !SERVER_ID_PATTERN.test(input.id)) {
    return undefined;
  }
  if (
    typeof input.hostname !== "string" ||
    !SERVER_HOSTNAME_PATTERN.test(input.hostname)
  ) {
    return undefined;
  }
  if (typeof input.ipAddress !== "string" || isIP(input.ipAddress) !== 4) {
    return undefined;
  }

  return {
    id: input.id,
    hostname: input.hostname,
    ipAddress: input.ipAddress,
    port: 443,
  };
}

export function matchesGameServerAddress(
  query: string,
  server: Pick<GameServerAddress, "id" | "hostname" | "ipAddress">,
): boolean {
  return (
    query === server.id ||
    query === server.hostname ||
    query === server.ipAddress
  );
}
