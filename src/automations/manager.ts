import {
  AutomationCatalog,
  type AutomationId,
  type AutomationSnapshot,
  type AutomationSettings,
  type AutomationState,
  type AutomationStatus,
  AvailableAutomations,
  createDefaultAutomationState,
  normalizeAutomationState,
  parseAutomationSettingsPatch,
  parseAutomationUpdate,
} from "./automations.ts";
import { createAhrcAutomation } from "./ahrc.ts";
import { createAutoBowAutomation } from "./auto-bow.ts";

type MaybePromise<T> = T | Promise<T>;
export type AutomationTimer = ReturnType<typeof setTimeout>;

export interface GuardedAutomationContext {
  readSessionState(): Readonly<Record<string, unknown>>;
  sendInput(input: Readonly<Record<string, unknown>>): void;
  sendRpc(name: string, payload: Readonly<Record<string, unknown>>): void;
  log?(message: string): void;
}

export interface AutomationContext extends GuardedAutomationContext {
  id: AutomationId;
  setTimeout(
    callback: () => MaybePromise<void>,
    delay: number,
  ): AutomationTimer;
  setInterval(
    callback: () => MaybePromise<void>,
    delay: number,
  ): AutomationTimer;
  clearTimer(timer: AutomationTimer): void;
  fail(error: unknown): void;
}

export interface AutomationLifecycle {
  start?(settings: AutomationSettings): MaybePromise<void>;
  stop?(): MaybePromise<void>;
  updateSettings?(settings: AutomationSettings): MaybePromise<void>;
  onEntityUpdate?(): MaybePromise<void>;
}

export type AutomationFactory = (
  context: AutomationContext,
) => AutomationLifecycle;

export const DefaultAutomationFactories: Record<AutomationId, AutomationFactory> = {
  ahrc: createAhrcAutomation,
  autoAim: () => ({}),
  autoBow: createAutoBowAutomation,
};

export interface AutomationManagerOptions {
  state?: unknown;
  context?: GuardedAutomationContext;
  factories?: Partial<Record<AutomationId, AutomationFactory>>;
  onChange?(state: AutomationState): void;
}

const emptyContext: GuardedAutomationContext = {
  readSessionState: () => Object.freeze({}),
  sendInput: () => {},
  sendRpc: () => {},
};

export class AutomationManager {
  private readonly state: AutomationState;
  private readonly context: GuardedAutomationContext;
  private readonly factories: Record<AutomationId, AutomationFactory>;
  private readonly onChange?: (state: AutomationState) => void;
  private readonly lifecycles = new Map<AutomationId, AutomationLifecycle>();
  private readonly running = new Set<AutomationId>();
  private readonly timers = new Map<AutomationId, Set<AutomationTimer>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AutomationManagerOptions = {}) {
    this.state = options.state
      ? normalizeAutomationState(options.state)
      : createDefaultAutomationState();
    this.context = options.context ?? emptyContext;
    this.factories = { ...DefaultAutomationFactories, ...options.factories };
    this.onChange = options.onChange;
  }

  initialize(): Promise<AutomationSnapshot> {
    return this.enqueue(async () => {
      for (const id of AvailableAutomations) {
        if (this.state[id].enabled && !this.running.has(id)) {
          await this.start(id);
        }
      }
      return this.getSnapshot();
    });
  }

  setEnabled(id: AutomationId, enabled: boolean): Promise<AutomationSnapshot> {
    return this.enqueue(async () => {
      const current = this.state[id];
      if (current.enabled === enabled && this.running.has(id) === enabled) {
        return this.getSnapshot();
      }

      if (enabled) await this.start(id);
      else await this.stop(id);
      this.emitChange();
      return this.getSnapshot();
    });
  }

  updateSettings(id: AutomationId, value: unknown): Promise<AutomationSnapshot> {
    const patch = parseAutomationSettingsPatch(id, value);
    return this.enqueue(async () => {
      const current = this.state[id];
      const changed = Object.entries(patch).some(
        ([key, setting]) =>
          (current.settings as unknown as Record<string, boolean>)[key] !==
          setting,
      );
      if (!changed) return this.getSnapshot();

      Object.assign(current.settings, patch);
      if (this.running.has(id)) {
        try {
          await this.lifecycle(id).updateSettings?.(current.settings);
        } catch (error) {
          await this.disableAfterError(id, error);
        }
      }
      this.emitChange();
      return this.getSnapshot();
    });
  }

  applyUpdate(id: AutomationId, value: unknown): Promise<AutomationSnapshot> {
    const update = parseAutomationUpdate(id, value);
    return this.enqueue(async () => {
      const current = this.state[id];
      let settingsChanged = false;
      if (update.settings) {
        settingsChanged = Object.entries(update.settings).some(
          ([key, setting]) =>
            (current.settings as unknown as Record<string, boolean>)[key] !==
            setting,
        );
        if (settingsChanged) Object.assign(current.settings, update.settings);
      }

      if (update.enabled === false) {
        if (current.enabled || this.running.has(id)) await this.stop(id);
      } else if (update.enabled === true && !this.running.has(id)) {
        await this.start(id);
      } else if (settingsChanged && this.running.has(id)) {
        try {
          await this.lifecycle(id).updateSettings?.(current.settings);
        } catch (error) {
          await this.disableAfterError(id, error);
        }
      }

      if (settingsChanged || update.enabled !== undefined) this.emitChange();
      return this.getSnapshot();
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      for (const id of AvailableAutomations) {
        if (this.state[id].enabled || this.running.has(id)) {
          await this.stop(id);
        } else {
          this.clearTimers(id);
        }
      }
      this.emitChange();
    });
  }

  getState(): AutomationState {
    return normalizeAutomationState(this.state);
  }

  getSnapshot(): AutomationSnapshot {
    return Object.fromEntries(
      AvailableAutomations.map((id) => {
        const current = this.state[id];
        const status: AutomationStatus = current.error
          ? "error"
          : this.running.has(id)
            ? "running"
            : current.enabled
              ? "starting"
              : "disabled";
        return [
          id,
          {
            enabled: current.enabled,
            status,
            settings: { ...current.settings },
            error: current.error,
          },
        ];
      }),
    ) as AutomationSnapshot;
  }

  handleEntityUpdate(): void {
    for (const id of this.running) {
      const handler = this.lifecycle(id).onEntityUpdate;
      if (!handler) continue;
      try {
        void Promise.resolve(handler()).catch((error) => this.fail(id, error));
      } catch (error) {
        this.fail(id, error);
      }
    }
  }

  private async start(id: AutomationId): Promise<void> {
    const current = this.state[id];
    current.error = null;
    try {
      await this.lifecycle(id).start?.(current.settings);
      current.enabled = true;
      this.running.add(id);
    } catch (error) {
      await this.disableAfterError(id, error);
    }
  }

  private async stop(id: AutomationId): Promise<void> {
    const current = this.state[id];
    current.enabled = false;
    this.running.delete(id);
    this.clearTimers(id);
    try {
      await this.lifecycle(id).stop?.();
      current.error = null;
    } catch (error) {
      current.error = formatError(error);
    }
  }

  private async disableAfterError(
    id: AutomationId,
    error: unknown,
  ): Promise<void> {
    const current = this.state[id];
    current.enabled = false;
    current.error = formatError(error);
    this.running.delete(id);
    this.clearTimers(id);
    try {
      await this.lifecycle(id).stop?.();
    } catch {
      // Preserve the original automation error.
    }
  }

  private lifecycle(id: AutomationId): AutomationLifecycle {
    const existing = this.lifecycles.get(id);
    if (existing) return existing;
    const lifecycle = this.factories[id](this.createContext(id));
    this.lifecycles.set(id, lifecycle);
    return lifecycle;
  }

  private createContext(id: AutomationId): AutomationContext {
    const timers = new Set<AutomationTimer>();
    this.timers.set(id, timers);
    const run = (callback: () => MaybePromise<void>) => {
      try {
        void Promise.resolve(callback()).catch((error) => this.fail(id, error));
      } catch (error) {
        this.fail(id, error);
      }
    };

    return {
      ...this.context,
      id,
      sendInput: (input) => {
        const ownedFields: readonly string[] =
          AutomationCatalog[id].ownership.inputFields;
        if (Object.keys(input).some((field) => !ownedFields.includes(field))) {
          throw new Error(`${id} attempted to write an unowned input field`);
        }
        this.context.sendInput(input);
      },
      sendRpc: (name, payload) => {
        const ownedRpcNames: readonly string[] =
          AutomationCatalog[id].ownership.rpcNames;
        if (!ownedRpcNames.includes(name)) {
          throw new Error(`${id} attempted to send an unowned RPC`);
        }
        this.context.sendRpc(name, payload);
      },
      setTimeout: (callback, delay) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          run(callback);
        }, delay);
        timers.add(timer);
        return timer;
      },
      setInterval: (callback, delay) => {
        const timer = setInterval(() => run(callback), delay);
        timers.add(timer);
        return timer;
      },
      clearTimer: (timer) => {
        clearTimeout(timer);
        clearInterval(timer);
        timers.delete(timer);
      },
      fail: (error) => this.fail(id, error),
    };
  }

  private fail(id: AutomationId, error: unknown): void {
    void this.enqueue(async () => {
      if (!this.state[id].enabled && !this.running.has(id)) return;
      await this.disableAfterError(id, error);
      this.emitChange();
    });
  }

  private clearTimers(id: AutomationId): void {
    for (const timer of this.timers.get(id) ?? []) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.get(id)?.clear();
  }

  private emitChange(): void {
    this.onChange?.(this.getState());
  }

  private enqueue<T>(operation: () => MaybePromise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
