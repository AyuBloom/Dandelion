import { expect, test } from "bun:test";

import { createAutoUpgraderAutomation } from "../src/automations/auto-upgrader.ts";
import type { AutomationContext } from "../src/automations/manager.ts";

interface RpcCall {
  name: string;
  payload: Readonly<Record<string, unknown>>;
}

const buildingSchema = {
  GoldStash: {
    woodCosts: [0, 0, 20, 30, 40, 50, 60, 70],
    stoneCosts: [0, 0, 10, 15, 20, 25, 30, 35],
    goldCosts: [0, 0, 0, 0, 0, 0, 0, 0],
  },
  ArrowTower: {
    woodCosts: [0, 10, 60, 30, 40, 50, 60, 70],
    stoneCosts: [0, 5, 20, 15, 20, 25, 30, 35],
    goldCosts: [0, 0, 5, 0, 0, 0, 0, 0],
  },
  Wall: {
    woodCosts: [0, 10, 50, 30, 40, 50, 60, 70],
    stoneCosts: [0, 5, 30, 15, 20, 25, 30, 35],
    goldCosts: [0, 0, 0, 0, 0, 0, 0, 0],
  },
};

test("Auto Upgrader upgrades only the Gold Stash until it reaches tier 8", async () => {
  const { lifecycle, rpcs } = harness({
    playerUid: 1,
    entities: [{ uid: 1, wood: 100, stone: 100, gold: 100 }],
    buildings: [
      { uid: 10, type: "GoldStash", tier: 2, x: 0, y: 0 },
      { uid: 11, type: "ArrowTower", tier: 2, x: 10, y: 10 },
    ],
    buildingSchema,
  });

  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 10 } },
  ]);
});

test("Auto Upgrader saves resources when the Gold Stash upgrade is unaffordable", async () => {
  const { lifecycle, rpcs } = harness({
    playerUid: 1,
    entities: [{ uid: 1, wood: 19, stone: 100, gold: 100 }],
    buildings: [
      { uid: 10, type: "GoldStash", tier: 2 },
      { uid: 11, type: "ArrowTower", tier: 1 },
    ],
    buildingSchema,
  });

  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([]);
});

test("Auto Upgrader upgrades affordable non-stash structures without overspending", async () => {
  const { lifecycle, rpcs } = harness({
    playerUid: 1,
    entities: [{ uid: 1, wood: 100, stone: 50, gold: 5 }],
    buildings: [
      { uid: 10, type: "GoldStash", tier: 8 },
      { uid: 11, type: "ArrowTower", tier: 2 },
      { uid: 12, type: "Wall", tier: 2 },
      { uid: 13, type: "Wall", tier: 8 },
    ],
    buildingSchema,
  });

  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 11 } },
  ]);
});

test("Auto Upgrader reevaluates independently on every entity update", async () => {
  const { lifecycle, rpcs } = harness({
    playerUid: 1,
    entities: [{ uid: 1, wood: 100, stone: 100, gold: 100 }],
    buildings: [{ uid: 10, type: "GoldStash", tier: 2 }],
    buildingSchema,
  });

  await lifecycle.onEntityUpdate?.();
  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 10 } },
    { name: "UpgradeBuilding", payload: { uid: 10 } },
  ]);
});

test("Auto Upgrader ignores incomplete or malformed session state", async () => {
  const states: Readonly<Record<string, unknown>>[] = [
    {},
    {
      playerUid: 1,
      entities: [{ uid: 1, wood: 100, stone: 100, gold: 100 }],
      buildings: [{ uid: 10, type: "GoldStash", tier: 2 }],
      buildingSchema: { GoldStash: { woodCosts: "invalid" } },
    },
    {
      playerUid: 1,
      entities: [{ uid: 1, wood: 100, stone: 100 }],
      buildings: [{ uid: 10, type: "GoldStash", tier: 2 }],
      buildingSchema,
    },
  ];

  for (const state of states) {
    const { lifecycle, rpcs } = harness(state);
    await lifecycle.onEntityUpdate?.();
    expect(rpcs).toEqual([]);
  }
});

function harness(state: Readonly<Record<string, unknown>>) {
  const rpcs: RpcCall[] = [];
  const context: AutomationContext = {
    id: "autoUpgrader",
    readSessionState: () => state,
    sendInput: () => {},
    sendRpc: (name, payload) => rpcs.push({ name, payload }),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    setInterval: (callback, delay) => setInterval(callback, delay),
    clearTimer: (timer) => {
      clearTimeout(timer);
      clearInterval(timer);
    },
    fail: (error) => {
      throw error;
    },
  };

  return { lifecycle: createAutoUpgraderAutomation(context), rpcs };
}
