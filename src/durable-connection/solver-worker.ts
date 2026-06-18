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

const solverProcessPath = fileURLToPath(new URL("../solver/process.ts", import.meta.url));

export class SolverWorker {
  private readonly pending = new Map<string, PendingCall>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private closed = false;
  private readonly exitHandlers = new Set<ExitHandler>();

  readonly child: SolverChild;

  constructor(private readonly hostname: string) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child = Bun.spawn({
      cmd: [process.execPath, solverProcessPath, "--hostname", hostname],
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
    if (isReadyMessage(message)) {
      logger.info("Solver worker attached", {
        hostname: this.hostname,
        pid: message.pid,
      });
      this.readyResolve();
      return;
    }

    if (!isSolverResponse(message)) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.payload.extra);
      return;
    }

    pending.reject(new DandelionError("SOLVER_IPC_FAILED", message.error));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isReadyMessage = (value: unknown): value is { type: "solver.ready"; pid: number } =>
  isRecord(value) && value.type === "solver.ready" && typeof value.pid === "number";

const isSolverResponse = (value: unknown): value is SolverResponse =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.ok === "boolean" &&
  (value.ok
    ? isRecord(value.payload) &&
      (value.payload.extra instanceof Uint8Array ||
        value.payload.extra instanceof ArrayBuffer)
    : typeof value.error === "string");
