import { expect, test } from "bun:test";

import {
  AutomationCatalog,
  AutomationValidationError,
  createAutomationViews,
  createDefaultAutomationState,
  normalizeAutomationState,
  parseAutomationSettingsPatch,
  parseAutomationUpdate,
} from "../src/automations/automations.ts";
import {
  AutomationManager,
  type AutomationLifecycle,
} from "../src/automations/manager.ts";

test("automation catalog exposes default-on checkboxes and narrow ownership", () => {
  expect(createDefaultAutomationState()).toEqual({
    ahrc: {
      enabled: false,
      settings: { collect: true, harvest: true },
      error: null,
    },
    autoAim: {
      enabled: false,
      settings: { players: true, zombies: true, npcs: true },
      error: null,
    },
    autoBow: {
      enabled: false,
      settings: {},
      error: null,
    },
    autoPet: {
      enabled: true,
      settings: {},
      error: null,
    },
    autoRebuilder: {
      enabled: false,
      settings: {},
      error: null,
    },
    autoUpgrader: {
      enabled: false,
      settings: {},
      error: null,
    },
    aulht: {
      enabled: false,
      settings: {},
      error: null,
    },
  });
  expect(AutomationCatalog.autoAim.ownership.inputFields).not.toContain("up");
  expect(AutomationCatalog.autoAim.ownership.inputFields).not.toContain("left");
  expect(AutomationCatalog.autoPet).toMatchObject({
    label: "Auto Evolve & Revive",
    implemented: true,
    ownership: { rpcNames: ["BuyItem", "EquipItem"] },
  });
  expect(AutomationCatalog.autoRebuilder.ownership.rpcNames).toEqual([
    "MakeBuilding",
    "UpgradeBuilding",
  ]);
  expect(AutomationCatalog.autoUpgrader.ownership.rpcNames).toEqual([
    "UpgradeBuilding",
  ]);
  expect(AutomationCatalog.aulht).toMatchObject({
    label: "AULHT",
    implemented: true,
    settings: [],
  });
});

test("Auto Bow releases and presses space on every entity update", async () => {
  const inputs: Readonly<Record<string, unknown>>[] = [];
  const manager = new AutomationManager({
    context: {
      readSessionState: () => ({}),
      sendInput: (input) => inputs.push(input),
      sendRpc: () => {},
    },
  });

  manager.handleEntityUpdate();
  expect(inputs).toEqual([]);

  await manager.setEnabled("autoBow", true);
  manager.handleEntityUpdate();
  manager.handleEntityUpdate();
  expect(inputs).toEqual([
    { space: 0 },
    { space: 1 },
    { space: 0 },
    { space: 1 },
  ]);
});

test("building automations act independently on the same structure", async () => {
  const rpcs: Array<{
    name: string;
    payload: Readonly<Record<string, unknown>>;
  }> = [];
  let buildings = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 8 },
    { uid: 11, type: "Wall", x: 48, y: 48, tier: 3 },
  ];
  const entities = [
    { uid: 1, wood: 100, stone: 100, gold: 100 },
    { uid: 11, health: 10, maxHealth: 100 },
  ];
  const manager = new AutomationManager({
    context: {
      readSessionState: () => ({
        playerUid: 1,
        entities,
        buildings,
        buildingSchema: {
          Wall: {
            woodCosts: [0, 10],
            stoneCosts: [0, 10],
            goldCosts: [0, 0],
          },
        },
      }),
      sendInput: () => {},
      sendRpc: (name, payload) => rpcs.push({ name, payload }),
    },
  });

  await manager.setEnabled("autoRebuilder", true);
  await manager.setEnabled("autoUpgrader", true);
  await manager.setEnabled("aulht", true);
  buildings = [
    { uid: 10, type: "GoldStash", x: 0, y: 0, tier: 8 },
    { uid: 11, type: "Wall", x: 48, y: 48, tier: 1 },
  ];
  manager.handleEntityUpdate();

  expect(rpcs).toEqual([
    { name: "UpgradeBuilding", payload: { uid: 11 } },
    { name: "UpgradeBuilding", payload: { uid: 11 } },
    { name: "UpgradeBuilding", payload: { uid: 11 } },
  ]);
});

test("AutoAim sends full aim input to the nearest enabled target", async () => {
  const inputs: Readonly<Record<string, unknown>>[] = [];
  const entities = [
    {
      uid: 1,
      model: "Player",
      partyId: 7,
      dead: 0,
      position: { x: 100, y: 200 },
    },
    {
      uid: 2,
      model: "PlayerObject",
      partyId: 7,
      dead: 0,
      position: { x: 101, y: 200 },
    },
    {
      uid: 3,
      model: "GamePlayer",
      partyId: 8,
      dead: 0,
      position: { x: 400, y: 200 },
    },
    { uid: 4, model: "Zombie", position: { x: 200, y: 200 } },
    { uid: 5, model: "NeutralTier1", position: { x: 130, y: 240 } },
  ];
  const manager = new AutomationManager({
    context: {
      readSessionState: () => ({ playerUid: 1, entities }),
      sendInput: (input) => inputs.push(input),
      sendRpc: () => {},
    },
  });

  await manager.setEnabled("autoAim", true);
  manager.handleEntityUpdate();

  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({
    mouseMoved: 143,
    worldX: 3000,
    worldY: 4000,
    distance: 50,
  });
});

test("AutoAim normalizes rounded yaw into the accepted input range", async () => {
  const inputs: Readonly<Record<string, unknown>>[] = [];
  const entities = [
    {
      uid: 1,
      model: "Player",
      dead: 0,
      position: { x: 0, y: 0 },
    },
    { uid: 2, model: "Zombie", position: { x: -0.5, y: -100 } },
  ];
  const manager = new AutomationManager({
    context: {
      readSessionState: () => ({ playerUid: 1, entities }),
      sendInput: (input) => inputs.push(input),
      sendRpc: () => {},
    },
  });

  await manager.setEnabled("autoAim", true);
  manager.handleEntityUpdate();

  expect(inputs[0]).toMatchObject({ mouseMoved: 0 });
});

test("AutoAim respects settings, range, and inactive player state", async () => {
  const inputs: Readonly<Record<string, unknown>>[] = [];
  let entities: Readonly<Record<string, unknown>>[] = [
    {
      uid: 1,
      model: "Player",
      partyId: 7,
      dead: 0,
      position: { x: 0, y: 0 },
    },
    { uid: 2, model: "NeutralTier1", position: { x: 10, y: 0 } },
    { uid: 3, model: "ZombieBoss", position: { x: 0, y: 500 } },
    {
      uid: 4,
      model: "Player",
      partyId: 8,
      dead: 0,
      position: { x: 0, y: 551 },
    },
  ];
  const manager = new AutomationManager({
    context: {
      readSessionState: () => ({ playerUid: 1, entities }),
      sendInput: (input) => inputs.push(input),
      sendRpc: () => {},
    },
  });

  await manager.applyUpdate("autoAim", {
    enabled: true,
    settings: { players: true, zombies: true, npcs: false },
  });
  manager.handleEntityUpdate();
  expect(inputs[0]).toMatchObject({
    mouseMoved: 180,
    worldX: 0,
    worldY: 50000,
    distance: 500,
  });

  entities = entities.map((entity) =>
    entity.uid === 1 ? { ...entity, dead: 1 } : entity,
  );
  manager.handleEntityUpdate();
  expect(inputs).toHaveLength(1);
});

test("automation views combine catalog fields with live state", async () => {
  const manager = new AutomationManager();
  await manager.setEnabled("ahrc", true);

  expect(createAutomationViews(manager.getSnapshot())[0]).toEqual({
    id: "ahrc",
    label: "AHRC",
    description: "Automatically harvest and collect harvester resources.",
    implementation: "active",
    enabled: true,
    status: "running",
    error: null,
    settings: { collect: true, harvest: true },
    fields: AutomationCatalog.ahrc.settings,
  });
});

test("AHRC probes and services every owned Harvester on entity updates", async () => {
  const rpcs: Array<{ name: string; payload: Readonly<Record<string, unknown>> }> = [];
  let entities: Readonly<Record<string, unknown>>[] = [
    { uid: 1, model: "PlayerObject", partyId: 7, gold: 10 },
    {
      uid: 10,
      model: "Harvester",
      partyId: 7,
      tier: 1,
      stone: 0,
      wood: 0,
      harvestMax: 100,
    },
    {
      uid: 11,
      model: "Harvester",
      partyId: 7,
      tier: 2,
      stone: 0,
      wood: 0,
      harvestMax: 200,
    },
    {
      uid: 12,
      model: "Harvester",
      partyId: 8,
      tier: 1,
      stone: 1,
      wood: 1,
      harvestMax: 100,
    },
  ];
  const manager = new AutomationManager({
    context: {
      readSessionState: () => ({ playerUid: 1, entities }),
      sendInput: () => {},
      sendRpc: (name, payload) => rpcs.push({ name, payload }),
    },
  });

  await manager.setEnabled("ahrc", true);
  manager.handleEntityUpdate();
  expect(rpcs).toEqual([
    {
      name: "AddDepositToHarvester",
      payload: { uid: 10, deposit: 0.69 },
    },
    {
      name: "AddDepositToHarvester",
      payload: { uid: 11, deposit: 0.69 },
    },
  ]);

  entities = entities.map((entity) =>
    entity.uid === 10 || entity.uid === 11
      ? { ...entity, stone: 1 }
      : entity,
  );
  manager.handleEntityUpdate();
  expect(rpcs.slice(2)).toEqual([
    {
      name: "AddDepositToHarvester",
      payload: { uid: 10, deposit: 0.030000000000000002 },
    },
    { name: "CollectHarvester", payload: { uid: 10 } },
    {
      name: "AddDepositToHarvester",
      payload: { uid: 11, deposit: 0.08 },
    },
    { name: "CollectHarvester", payload: { uid: 11 } },
  ]);
});

test("saved automation state is normalized against current defaults", () => {
  expect(
    normalizeAutomationState({
      ahrc: { enabled: true, settings: { collect: false, stale: true } },
      autoAim: { enabled: "yes", settings: { players: false, npcs: null } },
      removedAutomation: { enabled: true },
    }),
  ).toEqual({
    ahrc: {
      enabled: true,
      settings: { collect: false, harvest: true },
      error: null,
    },
    autoAim: {
      enabled: false,
      settings: { players: false, zombies: true, npcs: true },
      error: null,
    },
    autoBow: {
      enabled: false,
      settings: {},
      error: null,
    },
    autoPet: {
      enabled: true,
      settings: {},
      error: null,
    },
    autoRebuilder: {
      enabled: false,
      settings: {},
      error: null,
    },
    autoUpgrader: {
      enabled: false,
      settings: {},
      error: null,
    },
    aulht: {
      enabled: false,
      settings: {},
      error: null,
    },
  });
});

test("automation setting patches reject unknown and non-boolean values", () => {
  expect(parseAutomationSettingsPatch("ahrc", { collect: false })).toEqual({
    collect: false,
  });
  expect(() => parseAutomationSettingsPatch("ahrc", { collect: 1 })).toThrow(
    AutomationValidationError,
  );
  expect(() => parseAutomationSettingsPatch("autoAim", { bosses: true })).toThrow(
    "Invalid autoAim setting: bosses",
  );
});

test("automation updates validate the complete control payload", () => {
  expect(
    parseAutomationUpdate("autoAim", {
      enabled: true,
      settings: { players: false },
    }),
  ).toEqual({ enabled: true, settings: { players: false } });
  expect(() => parseAutomationUpdate("autoAim", {})).toThrow(
    "Invalid automation update",
  );
  expect(() => parseAutomationUpdate("autoAim", { enabled: 1 })).toThrow(
    "Automation enabled state must be boolean",
  );
});

test("a combined update starts with the new settings", async () => {
  const starts: unknown[] = [];
  const manager = new AutomationManager({
    factories: {
      autoAim: () => ({ start: (settings) => { starts.push({ ...settings }); } }),
    },
  });

  await manager.applyUpdate("autoAim", {
    enabled: true,
    settings: { players: false },
  });

  expect(starts).toEqual([{ players: false, zombies: true, npcs: true }]);
});

test("automation toggles are idempotent and settings update in flight", async () => {
  const calls: string[] = [];
  const lifecycle: AutomationLifecycle = {
    start: (settings) => { calls.push(`start:${JSON.stringify(settings)}`); },
    stop: () => { calls.push("stop"); },
    updateSettings: (settings) => {
      calls.push(`update:${JSON.stringify(settings)}`);
    },
  };
  const manager = new AutomationManager({
    factories: { ahrc: () => lifecycle },
  });

  await manager.setEnabled("ahrc", true);
  await manager.setEnabled("ahrc", true);
  await manager.updateSettings("ahrc", { collect: false });
  await manager.updateSettings("ahrc", { collect: false });
  await manager.setEnabled("ahrc", false);
  await manager.setEnabled("ahrc", false);

  expect(calls).toEqual([
    'start:{"collect":true,"harvest":true}',
    'update:{"collect":false,"harvest":true}',
    "stop",
  ]);
  expect(manager.getSnapshot().ahrc).toEqual({
    enabled: false,
    status: "disabled",
    settings: { collect: false, harvest: true },
    error: null,
  });
});

test("an automation exception disables only the failing automation", async () => {
  const manager = new AutomationManager({
    factories: {
      ahrc: () => ({ start: () => { throw new Error("harvester failed"); } }),
    },
  });

  await manager.setEnabled("autoAim", true);
  await manager.setEnabled("ahrc", true);

  expect(manager.getSnapshot()).toMatchObject({
    ahrc: { enabled: false, status: "error", error: "harvester failed" },
    autoAim: { enabled: true, status: "running", error: null },
  });
});

test("automation contexts allow only declared control fields", async () => {
  const sent: Readonly<Record<string, unknown>>[] = [];
  const allowed = new AutomationManager({
    context: {
      readSessionState: () => ({}),
      sendInput: (input) => sent.push(input),
      sendRpc: () => {},
    },
    factories: {
      autoAim: (context) => ({
        start: () => context.sendInput({ worldX: 10, worldY: 20 }),
      }),
    },
  });
  await allowed.setEnabled("autoAim", true);
  expect(sent).toEqual([{ worldX: 10, worldY: 20 }]);

  const rejected = new AutomationManager({
    context: {
      readSessionState: () => ({}),
      sendInput: (input) => sent.push(input),
      sendRpc: () => {},
    },
    factories: {
      autoAim: (context) => ({
        start: () => context.sendInput({ up: 1 }),
      }),
    },
  });
  await rejected.setEnabled("autoAim", true);
  expect(rejected.getSnapshot().autoAim).toMatchObject({
    enabled: false,
    status: "error",
    error: "autoAim attempted to write an unowned input field",
  });
  expect(sent).toHaveLength(1);
});

test("persisted enabled automations resume during initialization", async () => {
  let starts = 0;
  const manager = new AutomationManager({
    state: { ahrc: { enabled: true } },
    factories: { ahrc: () => ({ start: () => { starts += 1; } }) },
  });

  expect(manager.getSnapshot().ahrc.status).toBe("starting");
  await manager.initialize();
  await manager.initialize();

  expect(starts).toBe(1);
  expect(manager.getSnapshot().ahrc.status).toBe("running");
});

test("scoped timer errors disable an automation", async () => {
  let stopCalls = 0;
  const manager = new AutomationManager({
    factories: {
      ahrc: (context) => ({
        start: () => {
          context.setTimeout(() => { throw new Error("timer failed"); }, 0);
        },
        stop: () => { stopCalls += 1; },
      }),
    },
  });

  await manager.setEnabled("ahrc", true);
  await Bun.sleep(10);

  expect(manager.getSnapshot().ahrc).toMatchObject({
    enabled: false,
    status: "error",
    error: "timer failed",
  });
  expect(stopCalls).toBe(1);
});
