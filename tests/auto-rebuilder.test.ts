import { expect, test } from "bun:test";

import { createAutoRebuilderAutomation } from "../src/automations/auto-rebuilder.ts";
import { AutomationManager } from "../src/automations/manager.ts";

type Rpc = {
  name: string;
  payload: Readonly<Record<string, unknown>>;
};

function createManager(
  readSessionState: () => Readonly<Record<string, unknown>>,
  rpcs: Rpc[],
): AutomationManager {
  return new AutomationManager({
    context: {
      readSessionState,
      sendInput: () => {},
      sendRpc: (name, payload) => rpcs.push({ name, payload }),
    },
    factories: { autoRebuilder: createAutoRebuilderAutomation },
  });
}

test("Auto Rebuilder replaces missing snapshot buildings with captured placement", async () => {
  const rpcs: Rpc[] = [];
  let buildings: unknown[] = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 4 },
    { uid: 11, type: "ArrowTower", x: 48, y: 96, tier: 4, yaw: 90 },
    { uid: 12, type: "Wall", x: -48, y: 96, tier: 2 },
  ];
  const manager = createManager(() => ({ buildings }), rpcs);

  await manager.setEnabled("autoRebuilder", true);
  buildings = [buildings[0]];
  manager.handleEntityUpdate();

  expect(rpcs).toEqual([
    {
      name: "MakeBuilding",
      payload: { type: "ArrowTower", x: 48, y: 96, yaw: 90 },
    },
    {
      name: "MakeBuilding",
      payload: { type: "Wall", x: -48, y: 96, yaw: 0 },
    },
  ]);
});

test("Auto Rebuilder restores one tier per building per update within the stash cap", async () => {
  const rpcs: Rpc[] = [];
  let buildings: unknown[] = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 5 },
    { uid: 11, type: "ArrowTower", x: 48, y: 96, tier: 5 },
    { uid: 12, type: "Wall", x: -48, y: 96, tier: 4 },
  ];
  const manager = createManager(() => ({ buildings }), rpcs);

  await manager.setEnabled("autoRebuilder", true);
  buildings = [
    { uid: 20, type: "GoldStash", x: 0, y: 0, tier: 2 },
    { uid: 21, type: "ArrowTower", x: 48, y: 96, tier: 1 },
    { uid: 22, type: "Wall", x: -48, y: 96, tier: 2 },
  ];
  manager.handleEntityUpdate();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 20 } },
    { name: "UpgradeBuilding", payload: { uid: 21 } },
  ]);

  rpcs.length = 0;
  manager.handleEntityUpdate();
  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 20 } },
    { name: "UpgradeBuilding", payload: { uid: 21 } },
  ]);
});

test("Auto Rebuilder takes a deferred snapshot once and ignores later additions", async () => {
  const rpcs: Rpc[] = [];
  let buildings: unknown[] = [];
  const manager = createManager(() => ({ buildings }), rpcs);

  await manager.setEnabled("autoRebuilder", true);
  manager.handleEntityUpdate();

  buildings = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 2 },
    { uid: 11, type: "ArrowTower", x: 48, y: 96, tier: 2 },
  ];
  manager.handleEntityUpdate();

  buildings.push({ uid: 12, type: "Wall", x: -48, y: 96, tier: 2 });
  buildings = buildings.filter(
    (building) =>
      typeof building === "object" &&
      building !== null &&
      (building as { uid?: number }).uid !== 11,
  );
  manager.handleEntityUpdate();

  expect(rpcs).toEqual([
    {
      name: "MakeBuilding",
      payload: { type: "ArrowTower", x: 48, y: 96, yaw: 0 },
    },
  ]);
});

test("Auto Rebuilder recaptures the base after it is disabled and enabled", async () => {
  const rpcs: Rpc[] = [];
  let buildings: unknown[] = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 2 },
    { uid: 11, type: "ArrowTower", x: 48, y: 96, tier: 2 },
  ];
  const manager = createManager(() => ({ buildings }), rpcs);

  await manager.setEnabled("autoRebuilder", true);
  await manager.setEnabled("autoRebuilder", false);
  buildings = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 2 },
    { uid: 12, type: "Wall", x: -48, y: 96, tier: 2 },
  ];
  await manager.setEnabled("autoRebuilder", true);

  buildings = [buildings[0]];
  manager.handleEntityUpdate();

  expect(rpcs).toEqual([
    {
      name: "MakeBuilding",
      payload: { type: "Wall", x: -48, y: 96, yaw: 0 },
    },
  ]);
});
