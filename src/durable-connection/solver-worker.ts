import { fileURLToPath } from "node:url";

import { PacketIds } from "../network/enums.ts";
import { DandelionError } from "../shared/errors.ts";
import { logger } from "../shared/logger.ts";

type SolverChild = Bun.Subprocess & {
  send(message: unknown): void;
};

type PendingCall = {
  resolve(bytes: ArrayBuffer | Uint8Array): void;
  reject(error: Error): void;
};

type ExitHandler = (error: DandelionError) => void;

const solverProcessPath = fileURLToPath(new URL("../solver/process.ts", import.meta.url));

export class SolverWorker {
  private readonly pending = new Map<string, PendingCall>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private closed = false;
  private readonly exitHandlers = new Set<ExitHandler>();

  readonly child: SolverChild;

  constructor(private readonly ipAddress: string) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child = Bun.spawn({
      cmd: [process.execPath, solverProcessPath, "--ip-address", ipAddress],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      ipc: (message) => this.handleMessage(message),
    }) as SolverChild;

    this.child.exited.then((code) => {
      const wasClosed = this.closed;
      const error = new DandelionError(
        "SOLVER_EXITED",
        `Solver worker exited with code ${code}`,
      );
      this.closed = true;
      this.readyReject(error);

      for (const call of this.pending.values()) {
        call.reject(error);
      }
      this.pending.clear();

      if (!wasClosed) {
        for (const handler of this.exitHandlers) handler(error);
      }
    });
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  onUnexpectedExit(handler: ExitHandler): void {
    this.exitHandlers.add(handler);
  }

  solvePreEnter(challenge: Uint8Array): Promise<ArrayBuffer> {
    return this.solve(PacketIds.PACKET_PRE_ENTER_WORLD, challenge);
  }

  solveBlend(challenge: Uint8Array): Promise<ArrayBuffer> {
    return this.solve(PacketIds.PACKET_BLEND, challenge);
  }

  enterWorld2(): Promise<Uint8Array> {
    return this.call<Uint8Array>("solver.enterWorld2", {});
  }

  close(signal: NodeJS.Signals = "SIGTERM"): void {
    this.closed = true;
    this.child.kill(signal);
  }

  private solve(
    opcode: PacketIds.PACKET_PRE_ENTER_WORLD | PacketIds.PACKET_BLEND,
    challenge: Uint8Array,
  ): Promise<ArrayBuffer> {
    return this.call<ArrayBuffer>("solver.solve", {
      opcode,
      challenge: new Uint8Array(challenge),
    });
  }

  private call<TResult extends ArrayBuffer | Uint8Array>(
    type: string,
    payload: unknown,
  ): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(
        new DandelionError("SOLVER_EXITED", "Solver worker is closed"),
      );
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (bytes) => resolve(bytes as TResult),
        reject,
      });
      this.child.send({ id, type, payload });
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;

    const response = message as Record<string, unknown>;
    if (response.type === "solver.ready" && typeof response.pid === "number") {
      logger.debug("Solver worker attached", {
        ipAddress: this.ipAddress,
        pid: response.pid,
      });
      this.readyResolve();
      return;
    }

    if (typeof response.id !== "string" || typeof response.ok !== "boolean") {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    if (response.ok) {
      if (typeof response.payload !== "object" || response.payload === null) {
        return;
      }

      const extra = (response.payload as Record<string, unknown>).extra;
      if (!(extra instanceof Uint8Array || extra instanceof ArrayBuffer)) {
        return;
      }

      this.pending.delete(response.id);
      pending.resolve(extra);
      return;
    }

    if (typeof response.error !== "string") return;
    this.pending.delete(response.id);
    pending.reject(new DandelionError("SOLVER_IPC_FAILED", response.error));
  }
}
