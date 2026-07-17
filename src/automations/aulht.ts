import type { AutomationFactory } from "./manager.ts";

const LOW_HEALTH_RATIO = 0.2;

export const createAulhtAutomation: AutomationFactory = (context) => ({
  onEntityUpdate: () => {
    const state = context.readSessionState();
    const entities = Array.isArray(state.entities) ? state.entities : [];
    const buildings = Array.isArray(state.buildings) ? state.buildings : [];
    const goldStash = buildings.find(
      (building) => isRecord(building) && building.type === "GoldStash",
    );
    const goldStashTier = isRecord(goldStash)
      ? finiteNumber(goldStash.tier)
      : undefined;
    if (goldStashTier === undefined) return;

    for (const building of buildings) {
      if (!isRecord(building) || building.type === "GoldStash") continue;

      const uid = finiteNumber(building.uid);
      const tier = finiteNumber(building.tier);
      if (uid === undefined || tier === undefined || tier >= goldStashTier) {
        continue;
      }

      const entity = entities.find(
        (candidate) => isRecord(candidate) && candidate.uid === uid,
      );
      if (!isRecord(entity)) continue;

      const health = finiteNumber(entity.health);
      const maxHealth = finiteNumber(entity.maxHealth);
      if (
        health !== undefined &&
        maxHealth !== undefined &&
        maxHealth > 0 &&
        health / maxHealth <= LOW_HEALTH_RATIO
      ) {
        context.sendRpc("UpgradeBuilding", { uid });
      }
    }
  },
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
