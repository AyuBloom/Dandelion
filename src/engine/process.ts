import { ENGINE_PORT } from "../shared/config.ts";
import { Engine } from "./engine.ts";

export const engine = new Engine();

engine.listen(ENGINE_PORT);
