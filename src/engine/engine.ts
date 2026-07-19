import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";

import type { Socket, Subprocess } from "bun";
import { Elysia, t } from "elysia";
import type { ElysiaWS } from "elysia/ws";

import {
  AvailableAutomations,
  type AutomationId,
  type AutomationUpdate,
  type AutomationView,
} from "../automations/automations.ts";
import { PacketIds } from "../network/enums.ts";
import { ServerCodec } from "../network/server-codec.ts";
import { parseListenerInput } from "../session/input.ts";
import { SESSIONS_CACHE_TTL_MS } from "../shared/config.ts";
import type { ListenerId, SessionId } from "../shared/ids.ts";
import type { IpcMessage, SessionHealth, SyncData } from "../shared/ipc.ts";
import { feedback, logger } from "../shared/logger.ts";
import {
  getSessionControlPath,
  readSessionControlFrames,
  type SessionControlSocketData,
  writeSessionControlFrame,
} from "../shared/session-control.ts";
import {
  matchesGameServerAddress,
  parseGameServerAddress,
} from "../shared/server-address.ts";

interface SyncState {
  status: "waiting" | "syncing" | "live";
  snapshotTick?: number;
  queue: QueuedEntityUpdate[];
}

interface QueuedEntityUpdate {
  tick: number;
  data: ArrayBuffer;
}

interface AuthToken {
  sessionId: SessionId;
  expiresAt: number;
}

interface AuthFailures {
  count: number;
  resetAt: number;
}

type AuthErrorCode = "invalid_credentials" | "not_found" | "rate_limited";

type AuthResult =
  | { ok: true; token: string }
  | { ok: false; code: AuthErrorCode; error: string };

type StopSessionResult =
  | { ok: true }
  | {
      ok: false;
      code: "not_found" | "stop_failed" | "unauthorized";
      error: string;
    };

type AutomationErrorCode =
  | "invalid_request"
  | "not_found"
  | "unauthorized"
  | "unavailable";

type AutomationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: AutomationErrorCode; error: string };

interface PendingAutomationRequest {
  sessionId: SessionId;
  resolve(result: AutomationResult<AutomationView[]>): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Listener {
  id: ListenerId;
  sessionId: SessionId;
  ws: ElysiaWS;
  syncState: SyncState;
}

interface SessionsCache {
  data: SessionHealth[];
  lastReadAt: number;
}

interface SessionProcess {
  pid?: number;
  send(message: IpcMessage): void;
  kill?(signal: NodeJS.Signals): void;
  close?(): void;
}

const MAX_LISTENER_PACKET_BYTES = 1024;
const MAX_SYNC_QUEUE_PACKETS = 500;
const LISTENER_BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
const AUTH_TOKEN_TTL_MS = 60_000;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURES = 5;
const AUTH_DIRECTORY = ".session-auth";
const AUTH_REQUIRED_CLOSE_CODE = 4001;
const AUTOMATION_REQUEST_TIMEOUT_MS = 3_000;
const allowedListenerOpcodes = new Set<number>([
  PacketIds.PACKET_INPUT,
  PacketIds.PACKET_ENTER_WORLD,
  PacketIds.PACKET_PING,
  PacketIds.PACKET_RPC,
]);
const ignoredListenerOpcodes = new Set<number>([
  PacketIds.PACKET_ENTER_WORLD2,
  PacketIds.PACKET_BLEND,
]);

export class Engine {
  readonly app = new Elysia()
    .get(
      "/get-sessions",
      async ({ query: { server } }) => {
        const sessions = await this.getSessions();
        if (server) {
          return sessions.filter(
            ({ serverId, hostname, ipAddress }) =>
              matchesGameServerAddress(server, {
                id: serverId,
                hostname,
                ipAddress,
              }),
          );
        }
        return sessions;
      },
      {
        query: t.Object({
          server: t.Optional(
            t.String({
              minLength: 1,
              maxLength: 255,
              error: "Invalid server",
            }),
          ),
        }),
      },
    )
    .post(
      "/create-session",
      async ({ body, status }) => {
        const result = await this.createSession(body);
        return result.ok ? status(202, result) : status(500, result);
      },
      {
        body: t.Object({
          sessionName: t.String({
            maxLength: 29,
            error: "Invalid name (tip: length must be under 29 characters)",
          }),
          id: t.String({
            minLength: 5,
            maxLength: 5,
            pattern: "^v\\d{4}$",
            error: "Invalid server id",
          }),
          hostname: t.String({
            pattern: "^zombs-[a-z0-9]+-0\\.eggs\\.gg$",
            error: "Invalid hostname",
          }),
          ipAddress: t.String({
            format: "ipv4",
            error: "Invalid IP address",
          }),
          psk: t.Optional(
            t.String({
              minLength: 20,
              maxLength: 20,
              pattern: "^[a-zA-Z]+$",
              error: "Invalid Share Key",
            }),
          ),
          automations: t.Array(t.UnionEnum(AvailableAutomations), {
            maxItems: AvailableAutomations.length,
            uniqueItems: true,
            error: "Invalid automations",
          }),
          password: t.Optional(
            t.String({
              minLength: 8,
              maxLength: 32,
              error:
                "Invalid password (tip: length must be between 8 and 32 characters)",
            }),
          ),
          eventPassword: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/sessions/:id/auth",
      async ({ params, body, request, status }) => {
        const result = await this.createAuthToken(
          params.id as SessionId,
          body.password,
          this.getClientIdentity(request),
        );
        if (result.ok) return result;

        const statusCode =
          result.code === "not_found"
            ? 404
            : result.code === "rate_limited"
              ? 429
              : 401;
        return status(statusCode, result);
      },
      {
        params: t.Object({
          id: t.String({ format: "uuid" }),
        }),
        body: t.Object({
          password: t.String({ minLength: 8, maxLength: 32 }),
        }),
      },
    )
    .get(
      "/sessions/:id/automations",
      async ({ params, query, status }) => {
        const result = await this.getAutomations(
          params.id as SessionId,
          query.token,
        );
        if (result.ok) return result.data;
        return status(automationStatusCode(result.code), result);
      },
      {
        params: t.Object({
          id: t.String({ format: "uuid" }),
        }),
        query: t.Object({
          token: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
        }),
      },
    )
    .patch(
      "/sessions/:id/automations/:automationId",
      async ({ params, query, body, status }) => {
        const result = await this.updateAutomation(
          params.id as SessionId,
          params.automationId as AutomationId,
          body,
          query.token,
        );
        if (result.ok) return result.data;
        return status(automationStatusCode(result.code), result);
      },
      {
        params: t.Object({
          id: t.String({ format: "uuid" }),
          automationId: t.UnionEnum(AvailableAutomations),
        }),
        query: t.Object({
          token: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
        }),
        body: t.Object({
          enabled: t.Optional(t.Boolean()),
          settings: t.Optional(t.Record(t.String(), t.Boolean())),
        }),
      },
    )
    .delete(
      "/sessions/:id",
      async ({ params, query, status }) => {
        const result = await this.stopSession(
          params.id as SessionId,
          query.token,
        );
        if (result.ok) return status(202, result);
        const statusCode =
          result.code === "not_found"
            ? 404
            : result.code === "unauthorized"
              ? 401
              : 500;
        return status(statusCode, result);
      },
      {
        params: t.Object({
          id: t.String({ format: "uuid" }),
        }),
        query: t.Object({
          token: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
        }),
      },
    )
    .ws("/sessions/:id", {
      maxPayloadLength: MAX_LISTENER_PACKET_BYTES,
      backpressureLimit: LISTENER_BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      params: t.Object({
        id: t.String({
          format: "uuid",
        }),
      }),
      query: t.Object({
        token: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
      }),
      open: (ws) => this.openListener(ws),
      message: (ws, message) => {
        const packet = toPacketBytes(message);
        if (!packet) {
          ws.close(1003);
          return;
        }
        this.handleListenerMessage(ws, packet);
      },
      close: (ws) => this.closeListener(ws),
    });

  private readonly listenersBySession = new Map<SessionId, Set<ListenerId>>();
  private readonly listeners = new Map<ListenerId, Listener>();
  private readonly sessionByListener = new Map<ListenerId, SessionId>();
  private readonly sessions = new Map<SessionId, SessionProcess>();
  private readonly sessionIdByPid = new Map<number, SessionId>();
  private readonly passwordHashes = new Map<SessionId, string>();
  private readonly authTokens = new Map<string, AuthToken>();
  private readonly authFailures = new Map<string, AuthFailures>();
  private readonly pendingAutomationRequests = new Map<
    string,
    PendingAutomationRequest
  >();
  private readonly codec = new ServerCodec();
  private sessionsCache: SessionsCache = {
    data: [],
    lastReadAt: 0,
  };

  listen(port: number | string): void {
    this.app.listen(port);
    void this.getSessions().catch((error) => {
      logger.warn("Failed to attach existing sessions", { error });
    });
  }

  private async getSessions(): Promise<SessionHealth[]> {
    const now = Date.now();
    const cacheAge = now - this.sessionsCache.lastReadAt;

    if (cacheAge <= SESSIONS_CACHE_TTL_MS) {
      await this.reattachSessions(this.sessionsCache.data);
      return this.sessionsCache.data;
    }

    const sessionsDir = `${process.cwd()}/.sessions`;
    const files = await readdir(sessionsDir).catch(() => []);
    const data = await Promise.all(
      files.map(async (file) => {
        const content = await readFile(`${sessionsDir}/${file}`, "utf8");
        return JSON.parse(content) as SessionHealth;
      }),
    );
    await Promise.all(
      data.map(({ sessionId }) => this.loadPasswordHash(sessionId)),
    );
    this.sessionsCache = {
      data,
      lastReadAt: now,
    };

    await this.reattachSessions(data);
    return this.sessionsCache.data;
  }

  private async createSession(body: {
    sessionName: string;
    id: string;
    hostname: string;
    ipAddress: string;
    psk?: string;
    automations: AutomationId[];
    password?: string;
    eventPassword?: string;
  }): Promise<
    { ok: true; sessionId: SessionId } | { ok: false; error: string }
  > {
    const gameServer = parseGameServerAddress(body);
    if (!gameServer) return { ok: false, error: "Invalid server" };

    const sessionId = crypto.randomUUID();
    const args = [
      process.execPath,
      "src/session/process.ts",
      "--session-id",
      sessionId,
      "--session-name",
      body.sessionName,
      "--server-id",
      gameServer.id,
      "--hostname",
      gameServer.hostname,
      "--ip-address",
      gameServer.ipAddress,
      "--port",
      String(gameServer.port),
    ];
    if (body.psk) {
      args.push("--psk", body.psk);
    }
    if (body.automations.length > 0) {
      args.push("--automations", body.automations.join(","));
    }
    if (body.eventPassword !== undefined) {
      args.push("--event-password", body.eventPassword);
    }
    try {
      const passwordHash = body.password
        ? await Bun.password.hash(body.password)
        : undefined;
      if (passwordHash) {
        this.passwordHashes.set(sessionId, passwordHash);
        await this.persistPasswordHash(sessionId, passwordHash);
      }

      let child: Subprocess | undefined;
      child = Bun.spawn({
        cmd: args,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        detached: true,
        ipc: (message: IpcMessage) => this.handleSessionIPC(message, child),
      });
      this.sessionIdByPid.set(child.pid, sessionId);
      void child.exited.then(() => this.handleSessionExit(child));
      logger.info(feedback.sessionStarted, {
        sessionId,
        sessionName: body.sessionName,
        serverId: gameServer.id,
      });
      return { ok: true, sessionId };
    } catch (error) {
      this.passwordHashes.delete(sessionId);
      await this.removePasswordHash(sessionId);
      logger.error("Session creation failed", { error });
      return { ok: false, error: "Session creation failed" };
    }
  }

  private handleSessionIPC(message: IpcMessage, child?: SessionProcess): void {
    if (message.from !== "session") return;

    switch (message.type) {
      case "session.health":
        if (
          message.payload.status === "closed" ||
          message.payload.status === "failed"
        ) {
          this.removeSession(message.payload.sessionId);
          break;
        }
        if (child) {
          this.sessions.set(message.payload.sessionId, child);
          if (child.pid !== undefined) {
            this.sessionIdByPid.set(child.pid, message.payload.sessionId);
          }
        }
        if (!this.listenersBySession.has(message.payload.sessionId)) {
          this.listenersBySession.set(message.payload.sessionId, new Set());
        }

        this.sessionsCache = {
          data: [
            message.payload,
            ...this.sessionsCache.data.filter(
              (session) => session.sessionId !== message.payload.sessionId,
            ),
          ],
          lastReadAt: Date.now(),
        };
        break;
      case "durable.packet":
        this.forwardDurablePacket(
          message.payload.sessionId,
          message.payload.data,
          message.payload.entityTick,
        );
        break;
      case "session.ended":
        this.removeSession(message.payload.sessionId);
        break;
      case "session.sync":
        this.handleSessionSync(
          message.payload.sessionId,
          message.payload.listenerId,
          message.payload.syncData,
        );
        break;
      case "session.sync.unavailable":
        this.handleSessionSyncUnavailable(
          message.payload.sessionId,
          message.payload.listenerId,
          message.payload.reason,
        );
        break;
      case "session.automations":
        this.resolveAutomationRequest(
          message.payload.sessionId,
          message.payload.requestId,
          { ok: true, data: message.payload.automations },
        );
        break;
      case "session.automations.error":
        this.resolveAutomationRequest(
          message.payload.sessionId,
          message.payload.requestId,
          {
            ok: false,
            code: "invalid_request",
            error: message.payload.error,
          },
        );
        break;
      default:
        logger.warn(
          `Invalid IPC type (${message.from} -> ${message.type}): ${message.type} ${message.payload}`,
        );
        break;
    }
  }

  private forwardDurablePacket(
    sessionId: SessionId,
    data: ArrayBuffer,
    entityTick?: number,
  ): void {
    const listenerIds = this.listenersBySession.get(sessionId);
    if (!listenerIds) return;

    const isEntityUpdate = new Uint8Array(data)[0] === PacketIds.PACKET_ENTITY_UPDATE;
    for (const listenerId of listenerIds) {
      const listener = this.listeners.get(listenerId);
      if (!listener) continue;

      if (listener.syncState.status === "live") {
        if (
          isEntityUpdate &&
          entityTick !== undefined &&
          listener.syncState.snapshotTick !== undefined &&
          entityTick <= listener.syncState.snapshotTick
        ) {
          continue;
        }

        listener.ws.sendBinary(data);
        if (isEntityUpdate && entityTick !== undefined) {
          listener.syncState.snapshotTick = entityTick;
        }
      } else if (
        listener.syncState.status === "syncing" &&
        isEntityUpdate &&
        entityTick !== undefined
      ) {
        if (listener.syncState.queue.length >= MAX_SYNC_QUEUE_PACKETS) {
          this.removeListener(listenerId);
          listener.ws.close(1013);
          continue;
        }
        listener.syncState.queue.push({ tick: entityTick, data });
      }
    }
  }

  private handleSessionSync(
    sessionId: SessionId,
    listenerId: ListenerId,
    syncData: SyncData,
  ): void {
    const listener = this.listeners.get(listenerId);
    if (
      !listener ||
      listener.sessionId !== sessionId ||
      listener.syncState.status !== "syncing"
    ) {
      return;
    }

    listener.syncState.snapshotTick = syncData.snapshotTick;

    listener.ws.sendBinary(syncData.enterWorldPacket);
    for (const packet of syncData.rpcPackets) {
      listener.ws.sendBinary(packet);
    }
    listener.ws.sendBinary(syncData.freshEntityUpdatePacket);

    for (const packet of listener.syncState.queue) {
      if (packet.tick > syncData.snapshotTick) {
        listener.ws.sendBinary(packet.data);
        listener.syncState.snapshotTick = packet.tick;
      }
    }

    listener.syncState.status = "live";
    listener.syncState.queue.length = 0;
  }

  private handleSessionSyncUnavailable(
    sessionId: SessionId,
    listenerId: ListenerId,
    reason: string,
  ): void {
    logger.warn(`Listener #${listenerId} sync unavailable: ${reason}`);

    setTimeout(() => {
      const listener = this.listeners.get(listenerId);
      if (
        listener &&
        listener.sessionId === sessionId &&
        listener.syncState.status === "syncing"
      ) {
        this.requestListenerSync(listener);
      }
    }, 250);
  }

  private openListener(ws: ElysiaWS): void {
    const { params, query } = ws.data as {
      params: { id: SessionId };
      query: { token?: string };
    };
    const sessionId = params.id;
    if (!this.sessions.get(sessionId)) {
      ws.close(1008);
      return;
    }

    if (!this.consumeAuthToken(sessionId, query.token)) {
      ws.close(AUTH_REQUIRED_CLOSE_CODE);
      return;
    }
    ws.binaryType = "arraybuffer";

    const listenerIds = this.listenersBySession.get(sessionId);
    if (!listenerIds) {
      ws.close(1008);
      return;
    }

    listenerIds.add(ws.id);
    this.sessionByListener.set(ws.id, sessionId);
    this.listeners.set(ws.id, {
      ws,
      id: ws.id,
      sessionId,
      syncState: {
        status: "waiting",
        queue: [],
      },
    });
    logger.info(feedback.listenerAttached, {
      listenerId: ws.id,
      sessionId,
    });
  }

  private handleListenerMessage(ws: ElysiaWS, message: Uint8Array): void {
    if (!this.listeners.has(ws.id)) return;

    const opcode = message[0];
    if (opcode !== undefined && ignoredListenerOpcodes.has(opcode)) {
      logger.warn(
        `Packet ID ${PacketIds[opcode]} received. You should change your listener's client (if you own it) to omit sending this packet to the Session Saver for better performance.`,
      );
      return;
    }
    if (opcode === undefined || !allowedListenerOpcodes.has(opcode)) {
      logger.warn(`Rejected opcode from listener #${ws.id}: ${opcode}`);
      this.removeListener(ws.id);
      ws.close(1008);
      return;
    }

    switch (opcode) {
      case PacketIds.PACKET_INPUT:
        this.handleInput(ws, message);
        break;
      case PacketIds.PACKET_ENTER_WORLD:
        this.handleEnterWorld(ws);
        break;
      case PacketIds.PACKET_PING:
        this.handlePing(ws);
        break;
      case PacketIds.PACKET_RPC:
        this.handleRpc(ws, message);
        break;
      default:
        break;
    }
  }

  private handleInput(ws: ElysiaWS, message: Uint8Array): void {
    const listener = this.listeners.get(ws.id);
    const input = parseListenerInput(message);
    if (
      !listener ||
      listener.syncState.status !== "live" ||
      !input
    ) {
      return;
    }

    this.sendToSession(listener.sessionId, {
      type: "engine.input",
      from: "engine",
      to: "session",
      payload: message,
    } satisfies IpcMessage);
  }

  private handleEnterWorld(ws: ElysiaWS): void {
    const listener = this.listeners.get(ws.id);
    if (!listener || listener.syncState.status !== "waiting") return;

    listener.syncState.status = "syncing";
    listener.syncState.snapshotTick = undefined;
    listener.syncState.queue.length = 0;
    this.requestListenerSync(listener);
  }

  private requestListenerSync(listener: Listener): void {
    if (!this.sessions.has(listener.sessionId)) {
      listener.ws.close(1011);
      return;
    }

    this.sendToSession(listener.sessionId, {
      type: "engine.sync",
      from: "engine",
      to: "session",
      payload: {
        sessionId: listener.sessionId,
        listenerId: listener.id,
      },
    } satisfies IpcMessage);
  }

  private handlePing(ws: ElysiaWS): void {
    ws.sendBinary(this.codec.encodePing());
  }

  private handleRpc(ws: ElysiaWS, message: Uint8Array): void {
    const listener = this.listeners.get(ws.id);
    if (
      !listener ||
      listener.syncState.status !== "live"
    ) {
      return;
    }

    this.sendToSession(listener.sessionId, {
      type: "engine.rpc",
      from: "engine",
      to: "session",
      payload: message,
    } satisfies IpcMessage);
  }

  private closeListener(ws: ElysiaWS): void {
    this.removeListener(ws.id);
  }

  private removeListener(listenerId: ListenerId): void {
    const listener = this.listeners.get(listenerId);
    const sessionId = this.sessionByListener.get(listenerId);
    if (sessionId) {
      this.listenersBySession.get(sessionId)?.delete(listenerId);
    }

    this.sessionByListener.delete(listenerId);
    this.listeners.delete(listenerId);
    if (listener) {
      logger.info(feedback.listenerDetached, {
        listenerId,
        sessionId: listener.sessionId,
      });
    }
  }

  private removeSession(sessionId: SessionId): void {
    const child = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.failAutomationRequests(sessionId);
    child?.close?.();
    if (child?.pid !== undefined) this.sessionIdByPid.delete(child.pid);
    for (const [pid, mappedSessionId] of this.sessionIdByPid) {
      if (mappedSessionId === sessionId) this.sessionIdByPid.delete(pid);
    }

    const listenerIds = this.listenersBySession.get(sessionId);
    if (listenerIds) {
      for (const listenerId of [...listenerIds]) {
        const listener = this.listeners.get(listenerId);
        this.removeListener(listenerId);
        listener?.ws.close(1011);
      }
    }

    this.listenersBySession.delete(sessionId);
    this.passwordHashes.delete(sessionId);
    for (const key of this.authFailures.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.authFailures.delete(key);
    }
    for (const [token, auth] of this.authTokens) {
      if (auth.sessionId === sessionId) this.authTokens.delete(token);
    }
    this.sessionsCache = {
      data: this.sessionsCache.data.filter(
        (session) => session.sessionId !== sessionId,
      ),
      lastReadAt: Date.now(),
    };

    void rm(`.sessions/${sessionId}.json`, { force: true }).catch((error) => {
      logger.warn(`Failed to remove session health for ${sessionId}`, { error });
    });
    void rm(`.session-automations/${sessionId}.json`, { force: true }).catch(
      (error) => {
        logger.warn(`Failed to remove automations for ${sessionId}`, { error });
      },
    );
    void this.removePasswordHash(sessionId);
  }

  private handleSessionExit(child: Subprocess): void {
    const sessionId = this.sessionIdByPid.get(child.pid);
    if (sessionId) this.removeSession(sessionId);
  }

  private async getAutomations(
    sessionId: SessionId,
    token?: string,
  ): Promise<AutomationResult<{ automations: AutomationView[] }>> {
    const access = await this.authorizeAutomationRequest(sessionId, token);
    if (!access.ok) return access;

    const result = await this.requestAutomations(sessionId, (requestId) => ({
      type: "engine.automations.get",
      from: "engine",
      to: "session",
      payload: { sessionId, requestId },
    }));
    return result.ok
      ? { ok: true, data: { automations: result.data } }
      : result;
  }

  private async updateAutomation(
    sessionId: SessionId,
    automationId: AutomationId,
    update: AutomationUpdate,
    token?: string,
  ): Promise<AutomationResult<{ automation: AutomationView }>> {
    const access = await this.authorizeAutomationRequest(sessionId, token);
    if (!access.ok) return access;

    const result = await this.requestAutomations(sessionId, (requestId) => ({
      type: "engine.automation.update",
      from: "engine",
      to: "session",
      payload: { sessionId, requestId, automationId, update },
    }));
    if (!result.ok) return result;

    const automation = result.data.find(({ id }) => id === automationId);
    return automation
      ? { ok: true, data: { automation } }
      : {
          ok: false,
          code: "unavailable",
          error: "Automation response was incomplete",
        };
  }

  private async authorizeAutomationRequest(
    sessionId: SessionId,
    token?: string,
  ): Promise<AutomationResult<undefined>> {
    if (!this.sessions.has(sessionId)) await this.getSessions();
    if (!this.sessions.has(sessionId)) {
      return { ok: false, code: "not_found", error: "Session not found" };
    }

    await this.loadPasswordHash(sessionId);
    if (!this.consumeAuthToken(sessionId, token)) {
      return { ok: false, code: "unauthorized", error: "Unauthorized" };
    }
    return { ok: true, data: undefined };
  }

  private requestAutomations(
    sessionId: SessionId,
    createMessage: (requestId: string) => IpcMessage,
  ): Promise<AutomationResult<AutomationView[]>> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingAutomationRequests.delete(requestId);
        resolve({
          ok: false,
          code: "unavailable",
          error: "Session automation request timed out",
        });
      }, AUTOMATION_REQUEST_TIMEOUT_MS);

      this.pendingAutomationRequests.set(requestId, {
        sessionId,
        resolve,
        timeout,
      });
      if (this.sendToSession(sessionId, createMessage(requestId))) return;

      clearTimeout(timeout);
      this.pendingAutomationRequests.delete(requestId);
      resolve({
        ok: false,
        code: "unavailable",
        error: "Session is unavailable",
      });
    });
  }

  private resolveAutomationRequest(
    sessionId: SessionId,
    requestId: string,
    result: AutomationResult<AutomationView[]>,
  ): void {
    const pending = this.pendingAutomationRequests.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return;

    clearTimeout(pending.timeout);
    this.pendingAutomationRequests.delete(requestId);
    pending.resolve(result);
  }

  private failAutomationRequests(sessionId: SessionId): void {
    for (const [requestId, pending] of this.pendingAutomationRequests) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pendingAutomationRequests.delete(requestId);
      pending.resolve({
        ok: false,
        code: "unavailable",
        error: "Session is unavailable",
      });
    }
  }

  private async createAuthToken(
    sessionId: SessionId,
    password: string,
    clientIdentity: string,
  ): Promise<AuthResult> {
    if (!this.sessions.has(sessionId)) {
      await this.getSessions();
    }

    const passwordHash =
      this.passwordHashes.get(sessionId) ??
      (await this.loadPasswordHash(sessionId));
    if (!this.sessions.has(sessionId) || !passwordHash) {
      return {
        ok: false,
        code: "not_found",
        error: "Protected session not found",
      };
    }

    const now = Date.now();
    const failureKey = `${sessionId}:${clientIdentity}`;
    const failures = this.authFailures.get(failureKey);
    if (
      failures &&
      failures.resetAt > now &&
      failures.count >= MAX_AUTH_FAILURES
    ) {
      return {
        ok: false,
        code: "rate_limited",
        error: "Too many authentication attempts",
      };
    }

    const currentFailures =
      failures && failures.resetAt > now ? failures.count : 0;
    this.authFailures.set(failureKey, {
      count: currentFailures + 1,
      resetAt:
        failures && failures.resetAt > now
          ? failures.resetAt
          : now + AUTH_FAILURE_WINDOW_MS,
    });

    if (!(await Bun.password.verify(password, passwordHash))) {
      return {
        ok: false,
        code: "invalid_credentials",
        error: "Invalid password",
      };
    }

    this.authFailures.delete(failureKey);
    for (const [existingToken, auth] of this.authTokens) {
      if (auth.sessionId === sessionId || auth.expiresAt < now) {
        this.authTokens.delete(existingToken);
      }
    }
    const token = [crypto.randomUUID(), crypto.randomUUID()]
      .join("")
      .replaceAll("-", "");
    this.authTokens.set(token, {
      sessionId,
      expiresAt: now + AUTH_TOKEN_TTL_MS,
    });
    return { ok: true, token };
  }

  private async stopSession(
    sessionId: SessionId,
    token?: string,
  ): Promise<StopSessionResult> {
    if (!this.sessions.has(sessionId)) {
      await this.getSessions();
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, code: "not_found", error: "Session not found" };
    }
    if (!this.consumeAuthToken(sessionId, token)) {
      return { ok: false, code: "unauthorized", error: "Unauthorized" };
    }

    try {
      if (!session.kill) {
        return {
          ok: false,
          code: "stop_failed",
          error: "Session stop failed",
        };
      }
      session.kill("SIGTERM");
      return { ok: true };
    } catch (error) {
      logger.warn(`Failed to stop session ${sessionId}`, { error });
      return { ok: false, code: "stop_failed", error: "Session stop failed" };
    }
  }

  private consumeAuthToken(sessionId: SessionId, token?: string): boolean {
    if (!this.passwordHashes.has(sessionId)) return true;

    const authToken = token ? this.authTokens.get(token) : undefined;
    if (token) this.authTokens.delete(token);
    return Boolean(
      authToken &&
        authToken.sessionId === sessionId &&
        authToken.expiresAt >= Date.now(),
    );
  }

  private getClientIdentity(request: Request): string {
    return this.app.server?.requestIP(request)?.address ?? "unknown";
  }

  private async persistPasswordHash(
    sessionId: SessionId,
    passwordHash: string,
  ): Promise<void> {
    await mkdir(AUTH_DIRECTORY, { recursive: true });
    const path = `${AUTH_DIRECTORY}/${sessionId}.json`;
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporaryPath, JSON.stringify({ passwordHash }));
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async loadPasswordHash(
    sessionId: SessionId,
  ): Promise<string | undefined> {
    const existing = this.passwordHashes.get(sessionId);
    if (existing) return existing;

    const path = `${AUTH_DIRECTORY}/${sessionId}.json`;
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (!content) return undefined;

    try {
      const record = JSON.parse(content) as { passwordHash?: unknown };
      if (typeof record.passwordHash !== "string") return undefined;
      this.passwordHashes.set(sessionId, record.passwordHash);
      return record.passwordHash;
    } catch (error) {
      logger.warn(`Failed to load authentication for ${sessionId}`, { error });
      return undefined;
    }
  }

  private async removePasswordHash(sessionId: SessionId): Promise<void> {
    await rm(`${AUTH_DIRECTORY}/${sessionId}.json`, { force: true }).catch(
      (error) => {
        logger.warn(`Failed to remove authentication for ${sessionId}`, {
          error,
        });
      },
    );
  }

  private sendToSession(sessionId: SessionId, message: IpcMessage): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      session.send(message);
      return true;
    } catch (error) {
      logger.warn(`Failed to send IPC to session ${sessionId}`, { error });
      this.detachSession(sessionId);
      return false;
    }
  }

  private async reattachSessions(sessions: SessionHealth[]): Promise<void> {
    await Promise.all(
      sessions.map(async (session) => {
        if (
          this.sessions.has(session.sessionId) ||
          session.status === "closed" ||
          session.status === "failed"
        ) {
          return;
        }

        await this.reattachSession(session.sessionId);
      }),
    );
  }

  private async reattachSession(sessionId: SessionId): Promise<void> {
    let socket: Socket<SessionControlSocketData> | undefined;
    const handle: SessionProcess = {
      send: (message) => {
        if (
          !socket ||
          !writeSessionControlFrame(socket, { type: "ipc", message })
        ) {
          throw new Error("Session control socket is closed");
        }
      },
      kill: (signal) => {
        const controlSignal = signal === "SIGINT" ? "SIGINT" : "SIGTERM";
        if (
          !socket ||
          !writeSessionControlFrame(socket, {
            type: "terminate",
            signal: controlSignal,
          })
        ) {
          throw new Error("Session control socket is closed");
        }
      },
      close: () => {
        socket?.end();
        socket = undefined;
      },
    };

    try {
      socket = await Bun.connect<SessionControlSocketData>({
        unix: getSessionControlPath(sessionId),
        data: { buffer: "" },
        socket: {
          data: (connectedSocket, data) => {
            connectedSocket.data.buffer = readSessionControlFrames(
              connectedSocket.data.buffer,
              data,
              (frame) => {
                if (frame.type === "ipc") {
                  this.handleSessionIPC(frame.message, handle);
                }
              },
            );
          },
          close: () => {
            if (this.sessions.get(sessionId) === handle) {
              this.detachSession(sessionId);
            }
          },
          error: (_, error) => {
            logger.warn(`Session control socket failed for ${sessionId}`, {
              error,
            });
          },
        },
      });

      this.sessions.set(sessionId, handle);
      if (!this.listenersBySession.has(sessionId)) {
        this.listenersBySession.set(sessionId, new Set());
      }
      logger.info(feedback.existingSessionReattached, { sessionId });
    } catch (error) {
      logger.warn(`Failed to attach existing session ${sessionId}`, { error });
    }
  }

  private detachSession(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.failAutomationRequests(sessionId);
    session?.close?.();

    const listenerIds = this.listenersBySession.get(sessionId);
    if (listenerIds) {
      for (const listenerId of [...listenerIds]) {
        const listener = this.listeners.get(listenerId);
        this.removeListener(listenerId);
        listener?.ws.close(1011);
      }
    }

    this.listenersBySession.delete(sessionId);
  }
}

function automationStatusCode(
  code: AutomationErrorCode,
): 400 | 401 | 404 | 503 {
  switch (code) {
    case "invalid_request":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "unavailable":
      return 503;
  }
}

function toPacketBytes(message: unknown): Uint8Array | undefined {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return undefined;
}
