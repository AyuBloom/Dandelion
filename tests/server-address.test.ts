import { expect, test } from "bun:test";

import {
  matchesGameServerAddress,
  parseGameServerAddress,
} from "../src/shared/server-address.ts";

const validAddress = {
  id: "v1007",
  hostname: "zombs-2d4ca620-0.eggs.gg",
  ipAddress: "45.76.166.32",
};

test("game server address accepts the explicit server fields", () => {
  expect(parseGameServerAddress(validAddress)).toEqual({
    ...validAddress,
    port: 443,
  });
});

test("game server address rejects malformed fields", () => {
  expect(
    parseGameServerAddress({
      ...validAddress,
      id: "1007",
    }),
  ).toBeUndefined();
  expect(
    parseGameServerAddress({
      ...validAddress,
      hostname: "example.com",
    }),
  ).toBeUndefined();
  expect(
    parseGameServerAddress({
      ...validAddress,
      ipAddress: "999.76.166.32",
    }),
  ).toBeUndefined();
});

test("game server address matching supports id, hostname, and ip address", () => {
  expect(matchesGameServerAddress("v1007", validAddress)).toBeTrue();
  expect(
    matchesGameServerAddress("zombs-2d4ca620-0.eggs.gg", validAddress),
  ).toBeTrue();
  expect(matchesGameServerAddress("45.76.166.32", validAddress)).toBeTrue();
});
