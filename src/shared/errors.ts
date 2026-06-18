// Shared project errors keep process boundaries and logs easy to classify.
export type ErrorCode =
  | "SESSION_NOT_FOUND"
  | "DURABLE_CONNECTION_LOST"
  | "GUARD_REJECTED"
  | "INVALID_IPC_MESSAGE"
  | "INVALID_PROCESS_ARGS"
  | "PACKET_CODEC_ERROR"
  | "SERVER_CODEC_ERROR"
  | "SOLVER_INIT_FAILED"
  | "SOLVER_IPC_FAILED"
  | "SOLVER_EXITED";

export class DandelionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DandelionError";
  }
}

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
