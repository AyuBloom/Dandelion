import { expect, test } from "bun:test";

import { createAutoPetAutomation } from "../src/automations/auto-pet.ts";
import type { AutomationContext } from "../src/automations/manager.ts";

type Rpc = {
  name: string;
  payload: Readonly<Record<string, unknown>>;
};

test("Auto Evolve & Revive evolves only the equipped eligible pet", async () => {
  const state = {
    playerUid: 1,
    entities: [
      { uid: 1, petUid: 2, token: 100 },
      {
        uid: 2,
        model: "PetCARL",
        tier: 1,
        experience: 800,
        health: 100,
      },
      {
        uid: 3,
        model: "PetMiner",
        tier: 1,
        experience: 800,
        health: 100,
      },
    ],
  };
  const { lifecycle, rpcs } = harness(state);

  await lifecycle.onEntityUpdate?.();
  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "BuyItem", payload: { itemName: "PetCARL", tier: 2 } },
  ]);
  expect(rpcs.some(({ name }) => name === "EquipItem")).toBeFalse();
});

test("Auto Evolve & Revive waits for the evolved tier before continuing", async () => {
  const state = {
    playerUid: 1,
    entities: [
      { uid: 1, petUid: 2, token: 200 },
      {
        uid: 2,
        model: "PetCARL",
        tier: 1,
        experience: 1600,
        health: 100,
      },
    ],
  };
  const { lifecycle, rpcs } = harness(state);

  await lifecycle.onEntityUpdate?.();
  state.entities[1]!.tier = 2;
  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "BuyItem", payload: { itemName: "PetCARL", tier: 2 } },
    { name: "BuyItem", payload: { itemName: "PetCARL", tier: 3 } },
  ]);
});

test("Auto Evolve & Revive revives once per death", async () => {
  const state = {
    playerUid: 1,
    entities: [
      { uid: 1, petUid: 2, token: 0 },
      {
        uid: 2,
        model: "PetMiner",
        tier: 1,
        experience: 0,
        health: 0,
        dead: 1,
      },
    ],
  };
  const { lifecycle, rpcs } = harness(state);

  await lifecycle.onEntityUpdate?.();
  await lifecycle.onEntityUpdate?.();
  state.entities[1]!.health = 100;
  state.entities[1]!.dead = 0;
  await lifecycle.onEntityUpdate?.();
  state.entities[1]!.health = 0;
  state.entities[1]!.dead = 1;
  await lifecycle.onEntityUpdate?.();

  expect(rpcs).toEqual([
    { name: "BuyItem", payload: { itemName: "PetRevive", tier: 1 } },
    { name: "EquipItem", payload: { itemName: "PetRevive", tier: 1 } },
    { name: "BuyItem", payload: { itemName: "PetRevive", tier: 1 } },
    { name: "EquipItem", payload: { itemName: "PetRevive", tier: 1 } },
  ]);
});

test("Auto Evolve & Revive ignores ineligible and incomplete state", async () => {
  for (const state of [
    {},
    {
      playerUid: 1,
      entities: [
        { uid: 1, petUid: 2, token: 99 },
        {
          uid: 2,
          model: "PetCARL",
          tier: 1,
          experience: 800,
          health: 100,
        },
      ],
    },
    {
      playerUid: 1,
      entities: [
        { uid: 1, petUid: 2, token: 100 },
        {
          uid: 2,
          model: "PetCARL",
          tier: 1,
          experience: 799,
          health: 100,
        },
      ],
    },
  ]) {
    const { lifecycle, rpcs } = harness(state);
    await lifecycle.onEntityUpdate?.();
    expect(rpcs).toEqual([]);
  }
});

function harness(state: Readonly<Record<string, unknown>>) {
  const rpcs: Rpc[] = [];
  const context: AutomationContext = {
    id: "autoPet",
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

  return { lifecycle: createAutoPetAutomation(context), rpcs };
}
