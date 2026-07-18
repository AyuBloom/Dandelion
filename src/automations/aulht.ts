import type { AutomationFactory } from "./manager.ts";

const LOW_HEALTH_RATIO = 0.2;

export const createAulhtAutomation: AutomationFactory = (context) => {
  const triggered = new Set<number>();

  return {
    start: () => triggered.clear(),
    stop: () => triggered.clear(),
    onEntityUpdate: () => {
      const state = context.readSessionState();
      const entities = Array.isArray(state.entities) ? state.entities : [];
      const buildings = Array.isArray(state.buildings) ? state.buildings : [];
      const liveBuildingUids = new Set<number>();

      for (const building of buildings) {
        if (!isRecord(building)) continue;
        const uid = finiteNumber(building.uid);
        if (uid !== undefined) liveBuildingUids.add(uid);
      }
      for (const uid of triggered) {
        if (!liveBuildingUids.has(uid)) triggered.delete(uid);
      }

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
        if (uid === undefined || tier === undefined) continue;

        const entity = entities.find(
          (candidate) => isRecord(candidate) && candidate.uid === uid,
        );
        if (!isRecord(entity)) continue;

        const health = finiteNumber(entity.health);
        const maxHealth = finiteNumber(entity.maxHealth);
        if (health === undefined || maxHealth === undefined || maxHealth <= 0) {
          continue;
        }

        if (health / maxHealth > LOW_HEALTH_RATIO) {
          triggered.delete(uid);
          continue;
        }
        if (tier >= goldStashTier || triggered.has(uid)) continue;

        context.sendRpc("UpgradeBuilding", { uid });
        triggered.add(uid);
      }
    },
  };
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
