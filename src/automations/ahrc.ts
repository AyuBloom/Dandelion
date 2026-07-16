import type { AhrcSettings } from "./automations.ts";
import type {
  AutomationContext,
  AutomationFactory,
  AutomationLifecycle,
} from "./manager.ts";

const INITIAL_DEPOSIT = 0.69;

export const createAhrcAutomation: AutomationFactory = (context) => {
  const checkedHarvesters = new Set<number>();
  const workingHarvesters = new Set<number>();
  let settings: AhrcSettings = { collect: true, harvest: true };

  const reset = () => {
    checkedHarvesters.clear();
    workingHarvesters.clear();
  };

  return {
    start: (nextSettings) => {
      settings = nextSettings as AhrcSettings;
      reset();
    },
    stop: reset,
    updateSettings: (nextSettings) => {
      settings = nextSettings as AhrcSettings;
    },
    onEntityUpdate: () => runAhrcTick(
      context,
      settings,
      checkedHarvesters,
      workingHarvesters,
    ),
  } satisfies AutomationLifecycle;
};

function runAhrcTick(
  context: AutomationContext,
  settings: AhrcSettings,
  checkedHarvesters: Set<number>,
  workingHarvesters: Set<number>,
): void {
  const state = context.readSessionState();
  const playerUid = numberValue(state.playerUid);
  const entities = Array.isArray(state.entities) ? state.entities : [];
  if (playerUid === undefined) return;

  const player = entities.find(
    (entity) => isEntity(entity) && numberValue(entity.uid) === playerUid,
  );
  if (!isEntity(player)) return;

  const playerPartyId = numberValue(player.partyId);
  const playerGold = numberValue(player.gold);
  if (playerPartyId === undefined || playerGold === undefined) return;

  for (const candidate of entities) {
    if (!isEntity(candidate) || candidate.model !== "Harvester") continue;
    if (numberValue(candidate.partyId) !== playerPartyId) continue;

    const uid = numberValue(candidate.uid);
    if (uid === undefined) continue;

    if (checkedHarvesters.has(uid)) {
      const stone = numberValue(candidate.stone);
      const wood = numberValue(candidate.wood);
      const hasResources =
        (stone !== undefined && stone !== 0) ||
        (wood !== undefined && wood !== 0);
      if (hasResources) {
        workingHarvesters.add(uid);
      }
    } else if (playerGold > INITIAL_DEPOSIT) {
      checkedHarvesters.add(uid);
      context.sendRpc("AddDepositToHarvester", {
        uid,
        deposit: INITIAL_DEPOSIT,
      });
    }

    if (!workingHarvesters.has(uid)) continue;

    const tier = numberValue(candidate.tier);
    const stone = numberValue(candidate.stone);
    const wood = numberValue(candidate.wood);
    const harvestMax = numberValue(candidate.harvestMax);
    if (
      settings.harvest &&
      tier !== undefined &&
      stone !== undefined &&
      wood !== undefined &&
      harvestMax !== undefined &&
      (stone < harvestMax || wood < harvestMax)
    ) {
      context.sendRpc("AddDepositToHarvester", {
        uid,
        deposit: tier * 0.05 - 0.02,
      });
    }

    if (settings.collect) {
      context.sendRpc("CollectHarvester", { uid });
    }
  }
}

function isEntity(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
