import { PacketIds } from "../network/enums.ts";
import { DandelionError, getErrorMessage } from "../shared/errors.ts";
import { logger } from "../shared/logger.ts";
import Solver from "./solver.ts";

type SolverRequest =
  | {
      id: string;
      type: "solver.solve";
      payload: {
        opcode: PacketIds.PACKET_PRE_ENTER_WORLD | PacketIds.PACKET_BLEND;
        challenge: Uint8Array;
      };
    }
  | {
      id: string;
      type: "solver.enterWorld2";
      payload: {};
    };

type SolverResponse =
  | {
      id: string;
      ok: true;
      payload: {
        extra: ArrayBuffer | Uint8Array;
      };
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

const parent = process as typeof process & {
  send?: (message: unknown) => void;
};

const getArg = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};

const readArgs = () => {
  const hostname = getArg("--hostname");
  if (!hostname) throw new DandelionError("INVALID_PROCESS_ARGS", "Missing --hostname");
  return { hostname };
};

class SolverService {
  constructor(private readonly solver: Solver) {}

  solve(
    opcode: PacketIds.PACKET_PRE_ENTER_WORLD | PacketIds.PACKET_BLEND,
    challenge: Uint8Array,
  ): ArrayBuffer {
    // Opcode 5 has a one-time pre-enter reset before the normal blend solve.
    if (opcode === PacketIds.PACKET_PRE_ENTER_WORLD) {
      this.solver._MakeBlendField(255, 140);
    }

    this.solver._MakeBlendField(24, 132);
    const inputPtr = this.solver._MakeBlendField(228, challenge.byteLength);
    this.solver.HEAPU8.set(challenge, inputPtr);

    this.solver._MakeBlendField(172, 36);
    const outputPtr = this.solver._MakeBlendField(4, 152);
    return this.solver.HEAPU8.slice(outputPtr, outputPtr + 64).buffer as ArrayBuffer;
  }

  enterWorld2(): Uint8Array {
    const ptr = this.solver._MakeBlendField(187, 22);
    return this.solver.HEAPU8.slice(ptr, ptr + 16);
  }
}

const respond = (message: SolverResponse) => parent.send?.(message);

const main = async () => {
  const { hostname } = readArgs();
  const solver = new Solver(hostname);
  await solver.init();
  const service = new SolverService(solver);

  logger.info("Solver worker ready", { hostname, pid: process.pid });
  parent.send?.({ type: "solver.ready", pid: process.pid });

  process.on("message", (message: SolverRequest) => {
    try {
      if (message.type === "solver.solve") {
        const extra = service.solve(message.payload.opcode, message.payload.challenge);
        respond({ id: message.id, ok: true, payload: { extra } });
        return;
      }

      if (message.type === "solver.enterWorld2") {
        const extra = service.enterWorld2();
        respond({ id: message.id, ok: true, payload: { extra } });
      }
    } catch (error) {
      respond({
        id: message.id,
        ok: false,
        error: getErrorMessage(error),
      });
    }
  });
};

void main().catch((error) => {
  logger.error("Solver worker failed", getErrorMessage(error));
  process.exit(1);
});
