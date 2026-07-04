import { expect, test } from "bun:test";

import MiniCodec from "../src/network/mini-codec.ts";
import { ServerCodec } from "../src/network/server-codec.ts";
import { AttributeType } from "../src/network/enums.ts";
import type { EnterWorldData, EntityData } from "../src/shared/packets.ts";

test("mini codec keeps entity UID tables in sorted typed arrays", () => {
  const server = new ServerCodec({
    attributeMaps: {
      1: [{ name: "health", type: AttributeType.Uint32 }],
    },
    entityTypeNames: {
      1: "Player",
    },
  });
  const client = new MiniCodec();

  client.decode(server.encodeEnterWorldResponse(enterWorldData()));
  client.decode(server.encodeEntityUpdate({
    tick: 1,
    byteSize: 0,
    entities: new Map([
      [5, entity(5, 10)],
      [3, entity(3, 20)],
    ]),
  }));

  expect(client.sortedUidsByType[1]).toBeInstanceOf(Uint32Array);
  expect([...client.sortedUidsByType[1]!]).toEqual([3, 5]);

  client.decode(server.encodeEntityUpdate({
    tick: 2,
    byteSize: 0,
    removedUids: [3],
    entities: new Map([[4, entity(4, 30)]]),
  }));

  expect(client.sortedUidsByType[1]).toBeInstanceOf(Uint32Array);
  expect([...client.sortedUidsByType[1]!]).toEqual([4, 5]);

  const unchangedUidTable = client.sortedUidsByType[1];
  client.decode(server.encodeEntityUpdate({
    tick: 3,
    byteSize: 0,
    entities: new Map(),
  }));

  expect(client.sortedUidsByType[1]).toBe(unchangedUidTable);
});

function entity(uid: number, health: number): EntityData {
  return {
    uid,
    entityType: 1,
    health,
  };
}

function enterWorldData(): EnterWorldData {
  return {
    allowed: 1,
    uid: 7,
    startingTick: 1,
    tickRate: 20,
    effectiveTickRate: 20,
    players: 1,
    maxPlayers: 32,
    chatChannel: 0,
    effectiveDisplayName: "test",
    x1: 0,
    y1: 0,
    x2: 100,
    y2: 100,
  };
}
