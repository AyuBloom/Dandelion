import type {
  AutomationContext,
  AutomationFactory,
  AutomationLifecycle,
} from "./manager.ts";

interface Building {
  uid: number;
  type: string;
  x: number;
  y: number;
  tier: number;
  yaw: number;
}

interface CapturedBuilding {
  type: string;
  x: number;
  y: number;
  tier: number;
  yaw: number;
}

export const createAutoRebuilderAutomation: AutomationFactory = (context) => {
  let snapshot: CapturedBuilding[] | undefined;

  const capture = () => {
    const buildings = readBuildings(context.readSessionState().buildings);
    if (buildings.length === 0) return false;

    snapshot = buildings.map(({ type, x, y, tier, yaw }) => ({
      type,
      x,
      y,
      tier,
      yaw,
    }));
    return true;
  };

  return {
    start: () => {
      snapshot = undefined;
      capture();
    },
    stop: () => {
      snapshot = undefined;
    },
    onEntityUpdate: () => {
      if (!snapshot && !capture()) return;
      rebuild(context, snapshot ?? []);
    },
  } satisfies AutomationLifecycle;
};

function rebuild(
  context: AutomationContext,
  snapshot: readonly CapturedBuilding[],
): void {
  const buildings = readBuildings(context.readSessionState().buildings);
  const goldStashTier = buildings.find(
    (building) => building.type === "GoldStash",
  )?.tier;

  for (const captured of snapshot) {
    const building = buildings.find(
      (candidate) =>
        candidate.type === captured.type &&
        candidate.x === captured.x &&
        candidate.y === captured.y,
    );

    if (!building) {
      context.sendRpc("MakeBuilding", {
        type: captured.type,
        x: captured.x,
        y: captured.y,
        yaw: captured.yaw,
      });
      continue;
    }

    const targetTier = captured.type === "GoldStash"
      ? captured.tier
      : Math.min(captured.tier, goldStashTier ?? 0);
    if (building.tier < targetTier) {
      context.sendRpc("UpgradeBuilding", { uid: building.uid });
    }
  }
}

function readBuildings(value: unknown): Building[] {
  if (!Array.isArray(value)) return [];

  const buildings: Building[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const uid = numberValue(record.uid);
    const type = typeof record.type === "string" ? record.type : undefined;
    const x = numberValue(record.x);
    const y = numberValue(record.y);
    const tier = numberValue(record.tier);
    const yaw = record.yaw === undefined ? 0 : numberValue(record.yaw);
    if (
      uid === undefined ||
      !type ||
      x === undefined ||
      y === undefined ||
      tier === undefined ||
      yaw === undefined
    ) {
      continue;
    }

    buildings.push({ uid, type, x, y, tier, yaw });
  }
  return buildings;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
