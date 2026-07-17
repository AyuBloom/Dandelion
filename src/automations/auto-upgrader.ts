import type {
  AutomationContext,
  AutomationFactory,
  AutomationLifecycle,
} from "./manager.ts";

const GOLD_STASH = "GoldStash";
const MAX_BUILDING_TIER = 8;

interface Resources {
  wood: number;
  stone: number;
  gold: number;
}

interface Building {
  uid: number;
  type: string;
  tier: number;
}

export const createAutoUpgraderAutomation: AutomationFactory = (context) => ({
  onEntityUpdate: () => runAutoUpgraderTick(context),
} satisfies AutomationLifecycle);

function runAutoUpgraderTick(context: AutomationContext): void {
  const state = context.readSessionState();
  const playerUid = numberValue(state.playerUid);
  const entities = Array.isArray(state.entities) ? state.entities : [];
  const buildings = buildingValues(state.buildings);
  const buildingSchema = recordValue(state.buildingSchema);
  if (playerUid === undefined || !buildingSchema) return;

  const player = entities.find(
    (entity) =>
      isRecord(entity) && numberValue(entity.uid) === playerUid,
  );
  const resources = resourceValues(player);
  if (!resources) return;

  const stash = buildings.find((building) => building.type === GOLD_STASH);
  if (!stash) return;

  if (stash.tier < MAX_BUILDING_TIER) {
    upgradeIfAffordable(context, stash, buildingSchema, resources);
    return;
  }

  for (const building of buildings) {
    if (
      building.type === GOLD_STASH ||
      building.tier >= MAX_BUILDING_TIER ||
      building.tier >= stash.tier
    ) {
      continue;
    }

    upgradeIfAffordable(context, building, buildingSchema, resources);
  }
}

function upgradeIfAffordable(
  context: AutomationContext,
  building: Building,
  buildingSchema: Readonly<Record<string, unknown>>,
  resources: Resources,
): boolean {
  const costs = upgradeCosts(buildingSchema[building.type], building.tier);
  if (
    !costs ||
    costs.wood > resources.wood ||
    costs.stone > resources.stone ||
    costs.gold > resources.gold
  ) {
    return false;
  }

  resources.wood -= costs.wood;
  resources.stone -= costs.stone;
  resources.gold -= costs.gold;
  context.sendRpc("UpgradeBuilding", { uid: building.uid });
  return true;
}

function upgradeCosts(value: unknown, tier: number): Resources | undefined {
  const schema = recordValue(value);
  if (!schema) return undefined;

  const wood = costAtTier(schema.woodCosts, tier);
  const stone = costAtTier(schema.stoneCosts, tier);
  const gold = costAtTier(schema.goldCosts, tier);
  return wood === undefined || stone === undefined || gold === undefined
    ? undefined
    : { wood, stone, gold };
}

function costAtTier(value: unknown, tier: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const cost = numberValue(value[tier]);
  return cost !== undefined && cost >= 0 ? cost : undefined;
}

function buildingValues(value: unknown): Building[] {
  if (!Array.isArray(value)) return [];

  const buildings: Building[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;

    const uid = numberValue(candidate.uid);
    const tier = numberValue(candidate.tier);
    const type = candidate.type;
    if (
      uid === undefined ||
      !Number.isInteger(uid) ||
      uid < 0 ||
      tier === undefined ||
      !Number.isInteger(tier) ||
      tier < 1 ||
      tier > MAX_BUILDING_TIER ||
      typeof type !== "string" ||
      type.length === 0
    ) {
      continue;
    }

    buildings.push({ uid, type, tier });
  }
  return buildings;
}

function resourceValues(value: unknown): Resources | undefined {
  if (!isRecord(value)) return undefined;

  const wood = numberValue(value.wood);
  const stone = numberValue(value.stone);
  const gold = numberValue(value.gold);
  return wood === undefined || stone === undefined || gold === undefined
    ? undefined
    : { wood, stone, gold };
}

function recordValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
