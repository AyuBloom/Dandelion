import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

import { PacketIds } from "../src/network/enums.ts";
import MiniCodec from "../src/network/mini-codec.ts";
import type { AutomationView } from "../src/automations/automations.ts";
import { parseListenerInput } from "../src/session/input.ts";
import type { IpcMessage, SessionHealth, SyncData } from "../src/shared/ipc.ts";
import { Engine } from "../src/engine/engine.ts";
import {
  getSessionControlPath,
  readSessionControlFrames,
  SESSION_CONTROL_DIRECTORY,
  type SessionControlSocketData,
  writeSessionControlFrame,
} from "../src/shared/session-control.ts";

interface TestListener {
  id: string;
  sessionId: string;
  ws: {
    sendBinary: (packet: ArrayBuffer) => void;
    close?: (code: number) => void;
  };
  syncState: {
    status: "waiting" | "syncing" | "live";
    snapshotTick?: number;
    queue: Array<{ tick: number; data: ArrayBuffer }>;
  };
}

interface EngineTestHarness {
  listenersBySession: Map<string, Set<string>>;
  listeners: Map<string, TestListener>;
  sessionByListener: Map<string, string>;
  sessions: Map<
    string,
    {
      pid?: number;
      send: (message: unknown) => void;
      kill?: (signal: NodeJS.Signals) => void;
    }
  >;
  passwordHashes: Map<string, string>;
  authTokens: Map<string, { sessionId: string; expiresAt: number }>;
  handleListenerMessage(
    ws: { id: string; close?: (code: number) => void },
    message: Uint8Array,
  ): void;
  handleSessionIPC(message: IpcMessage): void;
  openListener(ws: unknown): void;
  createAuthToken(
    sessionId: string,
    password: string,
    clientIdentity: string,
  ): Promise<
    | { ok: true; token: string }
    | {
        ok: false;
        code: "invalid_credentials" | "not_found" | "rate_limited";
        error: string;
      }
  >;
  stopSession(
    sessionId: string,
    token?: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code: "not_found" | "stop_failed" | "unauthorized";
        error: string;
      }
  >;
  persistPasswordHash(sessionId: string, passwordHash: string): Promise<void>;
  loadPasswordHash(sessionId: string): Promise<string | undefined>;
  removePasswordHash(sessionId: string): Promise<void>;
  createSession(body: {
    sessionName: string;
    id: string;
    hostname: string;
    ipAddress: string;
    psk?: string;
    automations: string[];
    password?: string;
    eventPassword?: string;
  }): Promise<
    { ok: true; sessionId: string } | { ok: false; error: string }
  >;
  forwardDurablePacket(
    sessionId: string,
    data: ArrayBuffer,
    entityTick?: number,
  ): void;
  handleSessionSync(
    sessionId: string,
    listenerId: string,
    syncData: SyncData,
  ): void;
  reattachSessions(sessions: SessionHealth[]): Promise<void>;
  sendToSession(sessionId: string, message: IpcMessage): boolean;
}

test("create-session keeps event and session passwords separate", async () => {
  const realEngine = new Engine();
  const engine = realEngine as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  let received: Parameters<EngineTestHarness["createSession"]>[0] | undefined;

  engine.createSession = async (body) => {
    received = body;
    return { ok: true, sessionId };
  };

  const response = await realEngine.app.handle(
    new Request("http://localhost/create-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionName: "EventPlayer",
        id: "v1007",
        hostname: "zombs-2d4ca620-0.eggs.gg",
        ipAddress: "45.76.166.32",
        automations: [],
        password: "session-password",
        eventPassword: "dandelion-event",
      }),
    }),
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, sessionId });
  expect(received).toEqual({
    sessionName: "EventPlayer",
    id: "v1007",
    hostname: "zombs-2d4ca620-0.eggs.gg",
    ipAddress: "45.76.166.32",
    automations: [],
    password: "session-password",
    eventPassword: "dandelion-event",
  });
});

test("valid listener inputs are forwarded immediately", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sent: IpcMessage[] = [];
  const sessionId = "session";
  const listenerId = "listener";
  const codec = new MiniCodec();
  const firstInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { up: 1 }),
  );
  const secondInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { left: 1 }),
  );

  engine.sessions.set(sessionId, {
    send: (message) => sent.push(message as IpcMessage),
  });
  engine.listeners.set(listenerId, listener(listenerId, sessionId));
  engine.handleListenerMessage({ id: listenerId }, firstInput);
  engine.handleListenerMessage({ id: listenerId }, secondInput);

  expect(sent).toEqual([
    {
      type: "engine.input",
      from: "engine",
      to: "session",
      payload: firstInput,
    },
    {
      type: "engine.input",
      from: "engine",
      to: "session",
      payload: secondInput,
    },
  ]);
});

test("inputs from every live listener are forwarded", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sent: IpcMessage[] = [];
  const sessionId = "session";
  const firstListenerId = "listener-1";
  const secondListenerId = "listener-2";
  const codec = new MiniCodec();
  const firstInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { left: 1 }),
  );
  const secondInput = new Uint8Array(
    codec.encode(PacketIds.PACKET_INPUT, { right: 1 }),
  );

  engine.sessions.set(sessionId, {
    send: (message) => sent.push(message as IpcMessage),
  });
  engine.listeners.set(firstListenerId, listener(firstListenerId, sessionId));
  engine.listeners.set(secondListenerId, listener(secondListenerId, sessionId));

  engine.handleListenerMessage({ id: firstListenerId }, firstInput);
  engine.handleListenerMessage({ id: secondListenerId }, secondInput);

  expect(sent.map((message) => message.payload)).toEqual([firstInput, secondInput]);
});

test("waiting listeners cannot forward inputs", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sent: unknown[] = [];
  const sessionId = "session";
  const listenerId = "listener";
  const waiting = listener(listenerId, sessionId);
  waiting.syncState.status = "waiting";
  engine.sessions.set(sessionId, { send: (message) => sent.push(message) });
  engine.listeners.set(listenerId, waiting);

  const input = new Uint8Array(
    new MiniCodec().encode(PacketIds.PACKET_INPUT, { up: 1 }),
  );
  engine.handleListenerMessage({ id: listenerId }, input);

  expect(sent).toEqual([]);
});

test("listeners remain connected when compatibility opcodes are discarded", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  const listenerId = "listener";
  const closed: number[] = [];
  engine.listeners.set(listenerId, listener(listenerId, sessionId));
  engine.listenersBySession.set(sessionId, new Set([listenerId]));
  engine.sessionByListener.set(listenerId, sessionId);

  engine.handleListenerMessage(
    { id: listenerId, close: (code) => closed.push(code) },
    Uint8Array.of(PacketIds.PACKET_BLEND),
  );

  expect(closed).toEqual([]);
  expect(engine.listeners.has(listenerId)).toBeTrue();
});

test("listeners are closed for other opcodes outside the public allowlist", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  const listenerId = "listener";
  const closed: number[] = [];
  engine.listeners.set(listenerId, listener(listenerId, sessionId));
  engine.listenersBySession.set(sessionId, new Set([listenerId]));
  engine.sessionByListener.set(listenerId, sessionId);

  engine.handleListenerMessage(
    { id: listenerId, close: (code) => closed.push(code) },
    Uint8Array.of(8),
  );

  expect(closed).toEqual([1008]);
  expect(engine.listeners.has(listenerId)).toBeFalse();
});

test("every live listener can forward RPCs", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sent: unknown[] = [];
  const sessionId = "session";
  const firstListenerId = "listener-1";
  const secondListenerId = "listener-2";
  engine.sessions.set(sessionId, { send: (message) => sent.push(message) });
  engine.listeners.set(firstListenerId, listener(firstListenerId, sessionId));
  engine.listeners.set(secondListenerId, listener(secondListenerId, sessionId));

  const rpc = Uint8Array.of(PacketIds.PACKET_RPC, 0, 0, 0, 0);
  engine.handleListenerMessage({ id: firstListenerId }, rpc);
  engine.handleListenerMessage({ id: secondListenerId }, rpc);

  expect(sent).toEqual([
    {
      type: "engine.rpc",
      from: "engine",
      to: "session",
      payload: rpc,
    },
    {
      type: "engine.rpc",
      from: "engine",
      to: "session",
      payload: rpc,
    },
  ]);
});

test("a live listener forwards respawn input immediately", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sent: IpcMessage[] = [];
  const sessionId = "session";
  const listenerId = "listener";
  const respawn = new Uint8Array(
    new MiniCodec().encode(PacketIds.PACKET_INPUT, { respawn: 1 }),
  );

  engine.sessions.set(sessionId, {
    send: (message) => sent.push(message as IpcMessage),
  });
  engine.listenersBySession.set(sessionId, new Set([listenerId]));
  engine.listeners.set(listenerId, listener(listenerId, sessionId));

  engine.handleListenerMessage({ id: listenerId }, respawn);

  expect(sent).toHaveLength(1);
  expect(
    sent[0]?.type === "engine.input"
      ? parseListenerInput(sent[0].payload)
      : undefined,
  ).toEqual({ respawn: 1 });
});

test("Elysia accepts and returns binary WebSocket frames", async () => {
  const realEngine = new Engine();
  const engine = realEngine as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  let resolveIpc: (message: unknown) => void = () => {};
  const ipc = new Promise<unknown>((resolve) => {
    resolveIpc = resolve;
  });
  engine.sessions.set(sessionId, { send: resolveIpc });
  engine.listenersBySession.set(sessionId, new Set());
  realEngine.app.listen(0);

  const socket = new WebSocket(
    `ws://127.0.0.1:${realEngine.app.server!.port}/sessions/${sessionId}`,
  );
  socket.binaryType = "arraybuffer";

  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    socket.send(Uint8Array.of(PacketIds.PACKET_ENTER_WORLD));

    const message = await Promise.race([
      ipc,
      Bun.sleep(1000).then(() => {
        throw new Error("Timed out waiting for engine IPC");
      }),
    ]);
    expect(message).toMatchObject({
      type: "engine.sync",
      from: "engine",
      to: "session",
      payload: { sessionId },
    });

    const enterWorldPacket = packet(PacketIds.PACKET_ENTER_WORLD, 1);
    const received = new Promise<ArrayBuffer>((resolve, reject) => {
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else {
          reject(
            new Error(`Expected binary frame, received ${typeof event.data}`),
          );
        }
      };
    });
    engine.handleSessionSync(
      sessionId,
      (message as Extract<IpcMessage, { type: "engine.sync" }>).payload.listenerId,
      {
        snapshotTick: 1,
        enterWorldPacket,
        rpcPackets: [],
        freshEntityUpdatePacket: entityPacket(1),
      },
    );

    expect([...new Uint8Array(await received)]).toEqual([
      PacketIds.PACKET_ENTER_WORLD,
      1,
    ]);
  } finally {
    socket.close();
    await realEngine.app.stop(true);
  }
});

test("password-protected sessions reject invalid credentials", async () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  const closed: number[] = [];
  engine.sessions.set(sessionId, { send: () => {} });
  engine.listenersBySession.set(sessionId, new Set());
  engine.passwordHashes.set(sessionId, await Bun.password.hash("password123"));

  expect(await engine.createAuthToken(sessionId, "wrong", "client-a")).toEqual({
    ok: false,
    code: "invalid_credentials",
    error: "Invalid password",
  });
  const auth = await engine.createAuthToken(
    sessionId,
    "password123",
    "client-a",
  );
  expect(auth.ok).toBeTrue();
  if (!auth.ok) return;

  engine.openListener({
    id: "rejected",
    data: { params: { id: sessionId }, query: { token: "invalid" } },
    close: (code: number) => closed.push(code),
  });
  engine.openListener({
    id: "accepted",
    data: { params: { id: sessionId }, query: { token: auth.token } },
    close: (code: number) => closed.push(code),
  });
  engine.openListener({
    id: "replayed",
    data: { params: { id: sessionId }, query: { token: auth.token } },
    close: (code: number) => closed.push(code),
  });

  expect(closed).toEqual([1008, 1008]);
  expect(engine.listeners.has("rejected")).toBeFalse();
  expect(engine.listeners.has("accepted")).toBeTrue();
  expect(engine.listeners.has("replayed")).toBeFalse();
});

test("authentication limits failures per client instead of per session", async () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  engine.sessions.set(sessionId, { send: () => {} });
  engine.passwordHashes.set(sessionId, await Bun.password.hash("password123"));

  for (let attempt = 0; attempt < 5; attempt++) {
    await engine.createAuthToken(sessionId, "wrong", "client-a");
  }
  const limited = await engine.createAuthToken(
    sessionId,
    "password123",
    "client-a",
  );
  const otherClient = await engine.createAuthToken(
    sessionId,
    "password123",
    "client-b",
  );

  expect(limited).toMatchObject({ ok: false, code: "rate_limited" });
  expect(otherClient.ok).toBeTrue();
});

test("authentication hashes survive an in-memory cache reset", async () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  const passwordHash = await Bun.password.hash("password123");

  try {
    await engine.persistPasswordHash(sessionId, passwordHash);
    engine.passwordHashes.delete(sessionId);
    expect(await engine.loadPasswordHash(sessionId)).toBe(passwordHash);
  } finally {
    await engine.removePasswordHash(sessionId);
  }
});

test("session deletion requires authentication and sends SIGTERM", async () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  const signals: NodeJS.Signals[] = [];
  engine.sessions.set(sessionId, {
    send: () => {},
    kill: (signal) => signals.push(signal),
  });
  engine.passwordHashes.set(sessionId, await Bun.password.hash("password123"));

  expect(await engine.stopSession(sessionId)).toMatchObject({
    ok: false,
    code: "unauthorized",
  });
  const auth = await engine.createAuthToken(
    sessionId,
    "password123",
    "client-a",
  );
  if (!auth.ok) throw new Error("Expected authentication to succeed");

  expect(await engine.stopSession(sessionId, auth.token)).toEqual({ ok: true });
  expect(signals).toEqual(["SIGTERM"]);
});

test("authentication API returns a not-found HTTP status", async () => {
  const engine = new Engine();
  const response = await engine.app.handle(
    new Request(
      `http://localhost/sessions/${crypto.randomUUID()}/auth`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "password123" }),
      },
    ),
  );

  expect(response.status).toBe(404);
});

test("session deletion API returns accepted and signals the session", async () => {
  const realEngine = new Engine();
  const engine = realEngine as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  const signals: NodeJS.Signals[] = [];
  engine.sessions.set(sessionId, {
    send: () => {},
    kill: (signal) => signals.push(signal),
  });

  const response = await realEngine.app.handle(
    new Request(`http://localhost/sessions/${sessionId}`, {
      method: "DELETE",
    }),
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true });
  expect(signals).toEqual(["SIGTERM"]);
});

test("automation API reads and updates an unprotected session through IPC", async () => {
  const realEngine = new Engine();
  const engine = realEngine as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  const sent: IpcMessage[] = [];
  let views = automationViews();

  engine.sessions.set(sessionId, {
    send: (message) => {
      const request = message as IpcMessage;
      sent.push(request);
      if (request.type === "engine.automation.update") {
        views = views.map((automation) =>
          automation.id === request.payload.automationId
            ? {
                ...automation,
                enabled: request.payload.update.enabled ?? automation.enabled,
                status: request.payload.update.enabled
                  ? "running"
                  : automation.status,
                settings: {
                  ...automation.settings,
                  ...(request.payload.update.settings as Record<string, boolean>),
                },
              }
            : automation,
        );
      }
      if (
        request.type === "engine.automations.get" ||
        request.type === "engine.automation.update"
      ) {
        engine.handleSessionIPC({
          type: "session.automations",
          from: "session",
          to: "engine",
          payload: {
            sessionId,
            requestId: request.payload.requestId,
            automations: views,
          },
        });
      }
    },
  });

  const getResponse = await realEngine.app.handle(
    new Request(`http://localhost/sessions/${sessionId}/automations`),
  );
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toEqual({ automations: automationViews() });

  const patchResponse = await realEngine.app.handle(
    new Request(
      `http://localhost/sessions/${sessionId}/automations/autoAim`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          settings: { players: false },
        }),
      },
    ),
  );
  expect(patchResponse.status).toBe(200);
  expect(await patchResponse.json()).toMatchObject({
    automation: {
      id: "autoAim",
      enabled: true,
      status: "running",
      settings: { players: false, zombies: true, npcs: true },
    },
  });
  expect(sent.map(({ type }) => type)).toEqual([
    "engine.automations.get",
    "engine.automation.update",
  ]);
});

test("automation API maps a rejected session update to HTTP 400", async () => {
  const realEngine = new Engine();
  const engine = realEngine as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();

  engine.sessions.set(sessionId, {
    send: (message) => {
      const request = message as Extract<
        IpcMessage,
        { type: "engine.automation.update" }
      >;
      engine.handleSessionIPC({
        type: "session.automations.error",
        from: "session",
        to: "engine",
        payload: {
          sessionId,
          requestId: request.payload.requestId,
          error: "Invalid autoAim setting: buildings",
        },
      });
    },
  });

  const response = await realEngine.app.handle(
    new Request(
      `http://localhost/sessions/${sessionId}/automations/autoAim`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { buildings: true } }),
      },
    ),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    ok: false,
    code: "invalid_request",
    error: "Invalid autoAim setting: buildings",
  });
});

test("protected automation API consumes a valid token only once", async () => {
  const realEngine = new Engine();
  const engine = realEngine as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  const sent: IpcMessage[] = [];
  engine.passwordHashes.set(sessionId, await Bun.password.hash("password123"));
  engine.sessions.set(sessionId, {
    send: (message) => {
      const request = message as Extract<
        IpcMessage,
        { type: "engine.automations.get" }
      >;
      sent.push(request);
      engine.handleSessionIPC({
        type: "session.automations",
        from: "session",
        to: "engine",
        payload: {
          sessionId,
          requestId: request.payload.requestId,
          automations: automationViews(),
        },
      });
    },
  });

  const missing = await realEngine.app.handle(
    new Request(`http://localhost/sessions/${sessionId}/automations`),
  );
  expect(missing.status).toBe(401);
  expect(sent).toHaveLength(0);

  const auth = await engine.createAuthToken(
    sessionId,
    "password123",
    "automation-client",
  );
  if (!auth.ok) throw new Error("Expected authentication to succeed");

  const authorized = await realEngine.app.handle(
    new Request(
      `http://localhost/sessions/${sessionId}/automations?token=${auth.token}`,
    ),
  );
  expect(authorized.status).toBe(200);
  expect(sent).toHaveLength(1);

  const replayed = await realEngine.app.handle(
    new Request(
      `http://localhost/sessions/${sessionId}/automations?token=${auth.token}`,
    ),
  );
  expect(replayed.status).toBe(401);
  expect(sent).toHaveLength(1);
});

test("terminal sessions close and remove all listeners", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  const listenerId = "listener";
  const closed: number[] = [];
  const active = listener(listenerId, sessionId);
  active.ws.close = (code) => closed.push(code);
  engine.sessions.set(sessionId, { pid: 123, send: () => {} });
  engine.listenersBySession.set(sessionId, new Set([listenerId]));
  engine.listeners.set(listenerId, active);
  engine.sessionByListener.set(listenerId, sessionId);

  engine.handleSessionIPC({
    type: "session.ended",
    from: "session",
    to: "engine",
    payload: { sessionId, status: "failed" },
  });

  expect(closed).toEqual([1011]);
  expect(engine.sessions.has(sessionId)).toBeFalse();
  expect(engine.listeners.has(listenerId)).toBeFalse();
  expect(engine.listenersBySession.has(sessionId)).toBeFalse();
});

test("engine reattaches live session control sockets", async () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = crypto.randomUUID();
  const socketPath = getSessionControlPath(sessionId);
  const received: IpcMessage[] = [];
  const terminateSignals: string[] = [];
  const health = sessionHealth(sessionId);

  await mkdir(SESSION_CONTROL_DIRECTORY, { recursive: true });
  await rm(socketPath, { force: true });

  const server = Bun.listen<SessionControlSocketData>({
    unix: socketPath,
    socket: {
      open: (socket) => {
        socket.data = { buffer: "" };
        writeSessionControlFrame(socket, {
          type: "ipc",
          message: {
            type: "session.health",
            from: "session",
            to: "engine",
            payload: health,
          },
        });
      },
      data: (socket, data) => {
        socket.data.buffer = readSessionControlFrames(
          socket.data.buffer,
          data,
          (frame) => {
            if (frame.type === "ipc") {
              received.push(frame.message);
            } else {
              terminateSignals.push(frame.signal);
            }
          },
        );
      },
    },
  });

  try {
    await engine.reattachSessions([health]);
    expect(engine.sessions.has(sessionId)).toBeTrue();

    const syncMessage: IpcMessage = {
      type: "engine.sync",
      from: "engine",
      to: "session",
      payload: { sessionId, listenerId: "listener" },
    };
    expect(engine.sendToSession(sessionId, syncMessage)).toBeTrue();

    await Bun.sleep(25);
    expect(received).toEqual([syncMessage]);

    expect(await engine.stopSession(sessionId)).toEqual({ ok: true });
    await Bun.sleep(25);
    expect(terminateSignals).toEqual(["SIGTERM"]);
  } finally {
    server.stop(true);
    await rm(socketPath, { force: true });
  }
});

test("sync queues close listeners instead of growing without a bound", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sessionId = "session";
  const listenerId = "listener";
  const closed: number[] = [];
  const syncing = listener(listenerId, sessionId);
  syncing.syncState.status = "syncing";
  syncing.ws.close = (code) => closed.push(code);
  engine.listenersBySession.set(sessionId, new Set([listenerId]));
  engine.listeners.set(listenerId, syncing);
  engine.sessionByListener.set(listenerId, sessionId);

  for (let tick = 0; tick <= 500; tick++) {
    engine.forwardDurablePacket(sessionId, entityPacket(tick), tick);
  }

  expect(closed).toEqual([1013]);
  expect(engine.listeners.has(listenerId)).toBeFalse();
  expect(syncing.syncState.queue).toHaveLength(500);
});

test("sync sends the snapshot before queued entity updates", () => {
  const engine = new Engine() as unknown as EngineTestHarness;
  const sent: ArrayBuffer[] = [];
  const sessionId = "session";
  const listenerId = "listener";
  const listener: TestListener = {
    id: listenerId,
    sessionId,
    ws: { sendBinary: (packet) => sent.push(packet) },
    syncState: { status: "syncing", queue: [] },
  };

  engine.listenersBySession.set(sessionId, new Set([listenerId]));
  engine.listeners.set(listenerId, listener);

  const staleQueued = entityPacket(10);
  const newQueued = entityPacket(12);
  engine.forwardDurablePacket(sessionId, staleQueued, 10);
  engine.forwardDurablePacket(sessionId, newQueued, 12);

  const enterWorldPacket = packet(PacketIds.PACKET_ENTER_WORLD);
  const rpcPackets = [packet(PacketIds.PACKET_RPC, 1), packet(PacketIds.PACKET_RPC, 2)];
  const freshEntityUpdatePacket = entityPacket(11);

  engine.handleSessionSync(sessionId, listenerId, {
    snapshotTick: 11,
    enterWorldPacket,
    rpcPackets,
    freshEntityUpdatePacket,
  });

  expect(sent).toEqual([
    enterWorldPacket,
    ...rpcPackets,
    freshEntityUpdatePacket,
    newQueued,
  ]);
  expect(listener.syncState.status).toBe("live");
  expect(listener.syncState.queue).toEqual([]);

  engine.forwardDurablePacket(sessionId, entityPacket(11), 11);
  expect(sent).toHaveLength(5);

  const nextLivePacket = entityPacket(13);
  engine.forwardDurablePacket(sessionId, nextLivePacket, 13);
  expect(sent.at(-1)).toBe(nextLivePacket);
});

function entityPacket(marker: number): ArrayBuffer {
  return packet(PacketIds.PACKET_ENTITY_UPDATE, marker);
}

function packet(opcode: PacketIds, marker = 0): ArrayBuffer {
  return Uint8Array.of(opcode, marker).buffer;
}

function sessionHealth(sessionId: string): SessionHealth {
  const now = new Date().toISOString();
  return {
    sessionId,
    durableConnectionId: crypto.randomUUID(),
    sessionName: "test",
    createdAt: now,
    lastSeenAt: now,
    serverId: "v1007",
    hostname: "zombs-2d4ca620-0.eggs.gg",
    ipAddress: "45.76.166.32",
    status: "in-world",
  };
}

function listener(id: string, sessionId: string): TestListener {
  return {
    id,
    sessionId,
    ws: { sendBinary: () => {} },
    syncState: { status: "live", queue: [] },
  };
}

function automationViews(): AutomationView[] {
  return [
    {
      id: "ahrc",
      label: "AHRC",
      description: "Automatically harvest and collect harvester resources.",
      implementation: "mock",
      enabled: false,
      status: "disabled",
      error: null,
      settings: { collect: true, harvest: true },
      fields: [
        { key: "collect", label: "Collect", type: "boolean", default: true },
        { key: "harvest", label: "Harvest", type: "boolean", default: true },
      ],
    },
    {
      id: "autoAim",
      label: "AutoAim",
      description: "Aim at selected targets while preserving unrelated input.",
      implementation: "mock",
      enabled: false,
      status: "disabled",
      error: null,
      settings: { players: true, zombies: true, npcs: true },
      fields: [
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
    },
    {
      id: "autoBow",
      label: "Auto Bow",
      description: "Automatically fires the equipped bow on entity updates.",
      implementation: "active",
      enabled: false,
      status: "disabled",
      error: null,
      settings: {},
      fields: [],
    },
  ];
}
