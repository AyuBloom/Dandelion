import type { AutomationFactory } from "./manager.ts";

export const createAutoBowAutomation: AutomationFactory = (context) => ({
  onEntityUpdate: () => {
    context.sendInput({ space: 0 });
    context.sendInput({ space: 1 });
  },
});
