import type { AutoAimSettings } from "./automations.ts";
import type {
  AutomationContext,
  AutomationFactory,
  AutomationLifecycle,
} from "./manager.ts";

const MAX_TARGET_DISTANCE = 550;
const MAX_TARGET_DISTANCE_SQUARED = MAX_TARGET_DISTANCE ** 2;
const PLAYER_MODELS = new Set(["GamePlayer", "Player", "PlayerObject"]);

interface Position {
  x: number;
  y: number;
}

export const createAutoAimAutomation: AutomationFactory = (context) => {
  let settings: AutoAimSettings = {
    players: true,
    zombies: true,
    npcs: true,
  };

  return {
    start: (nextSettings) => {
      settings = nextSettings as AutoAimSettings;
    },
    updateSettings: (nextSettings) => {
      settings = nextSettings as AutoAimSettings;
    },
    onEntityUpdate: () => runAutoAimTick(context, settings),
  } satisfies AutomationLifecycle;
};

function runAutoAimTick(
  context: AutomationContext,
  settings: AutoAimSettings,
): void {
  const state = context.readSessionState();
  const playerUid = numberValue(state.playerUid);
  const entities = Array.isArray(state.entities) ? state.entities : [];
  if (playerUid === undefined) return;

  const player = entities.find(
    (entity) => isEntity(entity) && numberValue(entity.uid) === playerUid,
  );
  if (!isEntity(player) || numberValue(player.dead) === 1) return;

  const playerPosition = positionValue(player.position);
  if (!playerPosition) return;

  const playerPartyId = numberValue(player.partyId);
  let targetPosition: Position | undefined;
  let targetDistanceSquared = Infinity;

  for (const candidate of entities) {
    if (
      !isEntity(candidate) ||
      numberValue(candidate.uid) === playerUid ||
      numberValue(candidate.dead) === 1 ||
      !isEnabledTarget(candidate, settings, playerPartyId)
    ) {
      continue;
    }

    const position = positionValue(candidate.position);
    if (!position) continue;

    const deltaX = position.x - playerPosition.x;
    const deltaY = position.y - playerPosition.y;
    const distanceSquared = deltaX ** 2 + deltaY ** 2;
    if (
      distanceSquared > MAX_TARGET_DISTANCE_SQUARED ||
      distanceSquared >= targetDistanceSquared
    ) {
      continue;
    }

    targetPosition = position;
    targetDistanceSquared = distanceSquared;
  }

  if (!targetPosition) return;

  const worldX = targetPosition.x - playerPosition.x;
  const worldY = targetPosition.y - playerPosition.y;
  context.sendInput({
    mouseMoved: angleTo(playerPosition, targetPosition),
    worldX: worldX * 100,
    worldY: worldY * 100,
    distance: Math.sqrt(targetDistanceSquared),
  });
}

function isEnabledTarget(
  entity: Readonly<Record<string, unknown>>,
  settings: AutoAimSettings,
  playerPartyId: number | undefined,
): boolean {
  const model = typeof entity.model === "string" ? entity.model : "";

  if (PLAYER_MODELS.has(model)) {
    const partyId = numberValue(entity.partyId);
    if (!settings.players) return false;
    return playerPartyId === undefined || partyId !== playerPartyId;
  }

  if (model.startsWith("Zombie")) return settings.zombies;
  if (model.startsWith("Neutral")) return settings.npcs;
  return false;
}

function angleTo(from: Position, to: Position): number {
  const angle = (
    (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI +
    90 +
    360
  );
  return Math.round(angle) % 360;
}

function isEntity(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positionValue(value: unknown): Position | undefined {
  if (!isEntity(value)) return undefined;
  const x = numberValue(value.x);
  const y = numberValue(value.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
