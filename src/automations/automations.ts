export const AvailableAutomations = [
  "ahrc",
  "autoAim",
  "autoBow",
  "autoRebuilder",
  "autoUpgrader",
  "aulht",
] as const;

export type AutomationId = (typeof AvailableAutomations)[number];

export interface AhrcSettings {
  collect: boolean;
  harvest: boolean;
}

export interface AutoAimSettings {
  players: boolean;
  zombies: boolean;
  npcs: boolean;
}

export type AutoBowSettings = Record<never, never>;
export type AutoRebuilderSettings = Record<never, never>;
export type AutoUpgraderSettings = Record<never, never>;
export type AulhtSettings = Record<never, never>;

export interface AutomationSettingsById {
  ahrc: AhrcSettings;
  autoAim: AutoAimSettings;
  autoBow: AutoBowSettings;
  autoRebuilder: AutoRebuilderSettings;
  autoUpgrader: AutoUpgraderSettings;
  aulht: AulhtSettings;
}

export type AutomationSettings = AutomationSettingsById[AutomationId];

export interface AutomationUpdate {
  enabled?: boolean;
  settings?: unknown;
}

export interface ValidatedAutomationUpdate<T extends AutomationId> {
  enabled?: boolean;
  settings?: Partial<AutomationSettingsById[T]>;
}

export interface AutomationSettingDefinition {
  key: string;
  label: string;
  type: "boolean";
  default: boolean;
}

export interface AutomationDefinition {
  id: AutomationId;
  label: string;
  description: string;
  implemented: boolean;
  settings: readonly AutomationSettingDefinition[];
  ownership: {
    inputFields: readonly string[];
    rpcNames: readonly string[];
  };
}

export const AutomationCatalog = {
  ahrc: {
    id: "ahrc",
    label: "AHRC",
    description: "Automatically harvest and collect harvester resources.",
    implemented: true,
    settings: [
      { key: "collect", label: "Collect", type: "boolean", default: true },
      { key: "harvest", label: "Harvest", type: "boolean", default: true },
    ],
    ownership: {
      inputFields: [],
      rpcNames: ["AddDepositToHarvester", "CollectHarvester"],
    },
  },
  autoAim: {
    id: "autoAim",
    label: "Auto Aim",
    description: "Aim at selected targets while preserving unrelated input.",
    implemented: true,
    settings: [
      {
        key: "players",
        label: "Players (outside party)",
        type: "boolean",
        default: true,
      },
      {
        key: "zombies",
        label: "Zombies (including bosses)",
        type: "boolean",
        default: true,
      },
      {
        key: "npcs",
        label: "NPCs (neutrals)",
        type: "boolean",
        default: true,
      },
    ],
    ownership: {
      inputFields: [
        "mouseMoved",
        "mouseMovedWhileDown",
        "worldX",
        "worldY",
        "distance",
      ],
      rpcNames: [],
    },
  },
  autoBow: {
    id: "autoBow",
    label: "Auto Bow",
    description: "Automatically fires the equipped bow on entity updates.",
    implemented: true,
    settings: [],
    ownership: {
      inputFields: ["space"],
      rpcNames: [],
    },
  },
  autoRebuilder: {
    id: "autoRebuilder",
    label: "Auto Rebuilder",
    description: "Rebuild captured structures and restore their original tiers.",
    implemented: true,
    settings: [],
    ownership: {
      inputFields: [],
      rpcNames: ["MakeBuilding", "UpgradeBuilding"],
    },
  },
  autoUpgrader: {
    id: "autoUpgrader",
    label: "Auto Upgrader",
    description: "Check the Gold Stash first, then other structures by UID.",
    implemented: true,
    settings: [],
    ownership: {
      inputFields: [],
      rpcNames: ["UpgradeBuilding"],
    },
  },
  aulht: {
    id: "aulht",
    label: "AULHT",
    description: "Upgrade owned structures once when they reach 20% health.",
    implemented: true,
    settings: [],
    ownership: {
      inputFields: [],
      rpcNames: ["UpgradeBuilding"],
    },
  },
} as const satisfies Record<AutomationId, AutomationDefinition>;

export interface AutomationStateFor<T extends AutomationId> {
  enabled: boolean;
  settings: AutomationSettingsById[T];
  error: string | null;
}

export type AutomationState = {
  [T in AutomationId]: AutomationStateFor<T>;
};

export type AutomationStatus = "disabled" | "starting" | "running" | "error";

export type AutomationSnapshot = {
  [T in AutomationId]: AutomationStateFor<T> & { status: AutomationStatus };
};

export interface AutomationView {
  id: AutomationId;
  label: string;
  description: string;
  implementation: "mock" | "active";
  enabled: boolean;
  status: AutomationStatus;
  error: string | null;
  settings: AutomationSettings;
  fields: readonly AutomationSettingDefinition[];
}

export class AutomationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationValidationError";
  }
}

export function isAutomationId(value: unknown): value is AutomationId {
  return (
    typeof value === "string" &&
    AvailableAutomations.includes(value as AutomationId)
  );
}

export function createDefaultAutomationState(): AutomationState {
  return {
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
  };
}

export const createAutomationStates = createDefaultAutomationState;

export function createAutomationViews(
  snapshot: AutomationSnapshot,
): AutomationView[] {
  return AvailableAutomations.map((id) => {
    const definition = AutomationCatalog[id];
    const current = snapshot[id];
    return {
      id,
      label: definition.label,
      description: definition.description,
      implementation: definition.implemented ? "active" : "mock",
      enabled: current.enabled,
      status: current.status,
      error: current.error,
      settings: { ...current.settings },
      fields: definition.settings,
    };
  });
}

export function normalizeAutomationState(value: unknown): AutomationState {
  const state = createDefaultAutomationState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;

  for (const id of AvailableAutomations) {
    const candidate = (value as Record<string, unknown>)[id];
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }

    const saved = candidate as Record<string, unknown>;
    if (typeof saved.enabled === "boolean") state[id].enabled = saved.enabled;
    if (typeof saved.error === "string" || saved.error === null) {
      state[id].error = saved.error;
    }

    const settings = saved.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      continue;
    }

    const normalizedSettings = state[id].settings as unknown as Record<
      string,
      boolean
    >;
    for (const definition of AutomationCatalog[id].settings) {
      const setting = (settings as Record<string, unknown>)[definition.key];
      if (typeof setting === "boolean") {
        normalizedSettings[definition.key] = setting;
      }
    }
  }

  return state;
}

export function parseAutomationSettingsPatch<T extends AutomationId>(
  id: T,
  value: unknown,
): Partial<AutomationSettingsById[T]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AutomationValidationError("Automation settings must be an object");
  }

  const patch = value as Record<string, unknown>;
  const keys = new Set<string>(
    AutomationCatalog[id].settings.map(({ key }) => key),
  );
  for (const [key, setting] of Object.entries(patch)) {
    if (!keys.has(key) || typeof setting !== "boolean") {
      throw new AutomationValidationError(`Invalid ${id} setting: ${key}`);
    }
  }

  return patch as Partial<AutomationSettingsById[T]>;
}

export function parseAutomationUpdate<T extends AutomationId>(
  id: T,
  value: unknown,
): ValidatedAutomationUpdate<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AutomationValidationError("Automation update must be an object");
  }

  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length === 0 ||
    Object.keys(input).some((key) => key !== "enabled" && key !== "settings")
  ) {
    throw new AutomationValidationError("Invalid automation update");
  }
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    throw new AutomationValidationError(
      "Automation enabled state must be boolean",
    );
  }

  const update: ValidatedAutomationUpdate<T> = {};
  if (typeof input.enabled === "boolean") update.enabled = input.enabled;
  if ("settings" in input) {
    update.settings = parseAutomationSettingsPatch(id, input.settings);
  }
  return update;
}
