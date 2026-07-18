import { expect, test } from "bun:test";

import { createAulhtAutomation } from "../src/automations/aulht.ts";
import type { AutomationContext } from "../src/automations/manager.ts";

type RpcCall = {
  name: string;
  payload: Readonly<Record<string, unknown>>;
};

function createHarness(state: Readonly<Record<string, unknown>>) {
  const rpcs: RpcCall[] = [];
  const context = {
    readSessionState: () => state,
    sendRpc: (name: string, payload: Readonly<Record<string, unknown>>) => {
      rpcs.push({ name, payload });
    },
  } as unknown as AutomationContext;

  return { lifecycle: createAulhtAutomation(context), rpcs };
}

test("AULHT upgrades every low-health owned structure below the stash tier", () => {
  const { lifecycle, rpcs } = createHarness({
    buildings: [
      { uid: 1, type: "GoldStash", tier: 5 },
      { uid: 2, type: "ArrowTower", tier: 2 },
      { uid: 3, type: "Wall", tier: 4 },
      { uid: 4, type: "Door", tier: 5 },
      { uid: 5, type: "Harvester", tier: 1 },
    ],
    entities: [
      { uid: 1, health: 1, maxHealth: 100 },
      { uid: 2, health: 20, maxHealth: 100 },
      { uid: 3, health: 1, maxHealth: 100 },
      { uid: 4, health: 1, maxHealth: 100 },
      { uid: 5, health: 21, maxHealth: 100 },
    ],
  });

  lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 2 } },
    { name: "UpgradeBuilding", payload: { uid: 3 } },
  ]);
});

test("AULHT upgrades only once while a structure remains low health", () => {
  const { lifecycle, rpcs } = createHarness({
    buildings: [
      { uid: 1, type: "GoldStash", tier: 3 },
      { uid: 2, type: "MagicTower", tier: 1 },
    ],
    entities: [{ uid: 2, health: 10, maxHealth: 100 }],
  });

  lifecycle.onEntityUpdate?.();
  lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 2 } },
  ]);
});

test("AULHT can upgrade once again after the structure recovers", () => {
  const state = {
    buildings: [
      { uid: 1, type: "GoldStash", tier: 4 },
      { uid: 2, type: "Wall", tier: 1 },
    ],
    entities: [{ uid: 2, health: 10, maxHealth: 100 }],
  };
  const { lifecycle, rpcs } = createHarness(state);

  lifecycle.onEntityUpdate?.();
  state.entities[0]!.health = 100;
  lifecycle.onEntityUpdate?.();
  state.entities[0]!.health = 10;
  lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 2 } },
    { name: "UpgradeBuilding", payload: { uid: 2 } },
  ]);
});

test("AULHT ignores incomplete or invalid building health state", () => {
  const { lifecycle, rpcs } = createHarness({
    buildings: [
      { uid: 1, type: "GoldStash", tier: 4 },
      { uid: 2, type: "Wall", tier: 1 },
      { uid: 3, type: "Door", tier: 1 },
      { uid: 4, type: "Harvester", tier: Number.NaN },
      { uid: 5, type: "ArrowTower", tier: 1 },
    ],
    entities: [
      { uid: 2, health: 1 },
      { uid: 3, health: 0, maxHealth: 0 },
      { uid: 4, health: 1, maxHealth: 100 },
      { uid: 5, health: Number.POSITIVE_INFINITY, maxHealth: 100 },
    ],
  });

  lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([]);
});

test("AULHT does nothing without a finite Gold Stash tier", () => {
  const missingStash = createHarness({
    buildings: [{ uid: 2, type: "Wall", tier: 1 }],
    entities: [{ uid: 2, health: 1, maxHealth: 100 }],
  });
  const invalidStash = createHarness({
    buildings: [
      { uid: 1, type: "GoldStash", tier: "4" },
      { uid: 2, type: "Wall", tier: 1 },
    ],
    entities: [{ uid: 2, health: 1, maxHealth: 100 }],
  });

  missingStash.lifecycle.onEntityUpdate?.();
  invalidStash.lifecycle.onEntityUpdate?.();

  expect(missingStash.rpcs).toEqual([]);
  expect(invalidStash.rpcs).toEqual([]);
});
