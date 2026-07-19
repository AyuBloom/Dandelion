import type { AutomationFactory } from "./manager.ts";

const EVOLUTION_LEVELS = [8, 16, 24, 32, 48, 64, 96];
const EVOLUTION_TOKEN_COSTS = [100, 100, 100, 100, 200, 200, 300];

export const createAutoPetAutomation: AutomationFactory = (context) => {
  let petUid: number | undefined;
  let evolutionRequestedTier: number | undefined;
  let revived = false;

  return {
    start: reset,
    stop: reset,
    onEntityUpdate: () => {
      const state = context.readSessionState();
      const entities = Array.isArray(state.entities) ? state.entities : [];
      const player = entities.find(
        (entity) =>
          isRecord(entity) &&
          finiteNumber(entity.uid) === finiteNumber(state.playerUid),
      );
      const nextPetUid = isRecord(player)
        ? finiteNumber(player.petUid)
        : undefined;
      const pet = entities.find(
        (entity) => isRecord(entity) && finiteNumber(entity.uid) === nextPetUid,
      );
      if (!isRecord(player) || !isRecord(pet) || nextPetUid === undefined) return;

      if (petUid !== nextPetUid) {
        petUid = nextPetUid;
        evolutionRequestedTier = undefined;
        revived = false;
      }

      const dead = pet.dead === 1 || finiteNumber(pet.health) === 0;
      if (dead) {
        if (!revived) {
          context.sendRpc("BuyItem", { itemName: "PetRevive", tier: 1 });
          context.sendRpc("EquipItem", { itemName: "PetRevive", tier: 1 });
          revived = true;
        }
        return;
      }
      revived = false;

      const tier = finiteNumber(pet.tier);
      const experience = finiteNumber(pet.experience);
      const tokens = finiteNumber(player.token);
      const model = pet.model;
      if (
        tier === undefined ||
        !Number.isInteger(tier) ||
        tier < 1 ||
        tier > EVOLUTION_LEVELS.length ||
        experience === undefined ||
        tokens === undefined ||
        typeof model !== "string" ||
        Math.floor(experience / 100) < EVOLUTION_LEVELS[tier - 1]! ||
        tokens < EVOLUTION_TOKEN_COSTS[tier - 1]! ||
        evolutionRequestedTier === tier
      ) {
        return;
      }

      context.sendRpc("BuyItem", { itemName: model, tier: tier + 1 });
      evolutionRequestedTier = tier;
    },
  };

  function reset(): void {
    petUid = undefined;
    evolutionRequestedTier = undefined;
    revived = false;
  }
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
