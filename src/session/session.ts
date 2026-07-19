import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Socket, Subprocess, UnixSocketListener } from "bun";

import {
  createAutomationViews,
  createDefaultAutomationState,
  isAutomationId,
  type AutomationId,
  type AutomationState,
} from "../automations/automations.ts";
import { AutomationManager } from "../automations/manager.ts";
import { PacketIds } from "../network/enums.ts";
import { ServerCodec } from "../network/server-codec.ts";
import { getErrorMessage } from "../shared/errors.ts";
import type { IpcMessage, SessionHealth, SyncData } from "../shared/ipc.ts";
import { feedback, logger } from "../shared/logger.ts";
import type { SessionId } from "../shared/ids.ts";
import {
  getSessionControlPath,
  readSessionControlFrames,
  SESSION_CONTROL_DIRECTORY,
  type SessionControlFrame,
  type SessionControlSignal,
  type SessionControlSocketData,
  writeSessionControlFrame,
} from "../shared/session-control.ts";
import {
  getSessionRescuePath,
  readSessionRescueFrames,
  SESSION_RESCUE_DIRECTORY,
  type SessionRescueFrame,
  type SessionRescueSocketData,
  writeSessionRescueFrame,
} from "../shared/session-rescue.ts";
import type {
  ClientRpcData,
  EntityData,
  EntityUpdateData,
  EnterWorldData,
  RpcData,
  RpcObject,
} from "../shared/packets.ts";
import MiniCodec from "../network/mini-codec.ts";
import { parseInputPacketData, parseListenerInput } from "./input.ts";
import { isValidListenerRpc, MAX_RPC_PACKET_BYTES } from "./rpc.ts";

export interface SessionOptions {
  sessionId: SessionId;
  sessionName: string;
  serverId: string;
  hostname: string;
  ipAddress: string;
  port?: number;
  psk?: string;
  automations?: AutomationId[];
  eventPassword?: string;
}

const MAX_MESSAGE_HISTORY = 500;
const AUTOMATION_DIRECTORY = ".session-automations";

const singleSyncRpcNames = [
  "PartyInfo",
  "PartyShareKey",
  "DayCycle",
  "SetPartyList",
  "Spells",
  "BuildingShopPrices",
  "ItemShopPrices",
] as const;

type SingleSyncRpcName = (typeof singleSyncRpcNames)[number];

const durableProcessPath = fileURLToPath(
  new URL("../durable-connection/process.ts", import.meta.url),
);

const parent = process as typeof process & {
  send?: (message: unknown) => void;
};

export class Session {
  private readonly health: SessionHealth;
  private durableConnection?: Subprocess;
  private controlServer?: UnixSocketListener<SessionControlSocketData>;
  private rescueServer?: UnixSocketListener<SessionRescueSocketData>;
  private clientCodec: MiniCodec;
  private serverCodec: ServerCodec;
  private enterWorld?: EnterWorldData;
  private latestTick?: number;
  private readonly entitySnapshot = new Map<number, EntityData>();
  private readonly entityTypesByUid = new Map<number, number>();
  private readonly singleRpcPackets: Partial<Record<SingleSyncRpcName, ArrayBuffer>> = {};
  private readonly chatPackets: ArrayBuffer[] = [];
  private readonly localBuildingsByUid = new Map<number, RpcObject>();
  private buildingSchema: Readonly<Record<string, unknown>> = Object.freeze({});
  private readonly virtualInventory = new Map<string, RpcObject>();
  private healthWrites = Promise.resolve();
  private automationWrites = Promise.resolve();
  private pskSent = false;
  private readonly port: number;
  private readonly controlClients = new Set<Socket<SessionControlSocketData>>();
  private automationManager: AutomationManager;

  constructor(private readonly options: SessionOptions) {
    const createdAt = new Date().toISOString();
    this.port = options.port ?? 443;

    this.health = {
      sessionId: options.sessionId,
      durableConnectionId: crypto.randomUUID(),
      sessionName: options.sessionName,
      createdAt,
      lastSeenAt: createdAt,
      serverId: options.serverId,
      hostname: options.hostname,
      ipAddress: options.ipAddress,
      status: "booting",
    };

    this.clientCodec = new MiniCodec();
    this.serverCodec = new ServerCodec();
    this.automationManager = this.createAutomationManager(
      this.createInitialAutomationState(),
    );
  }

  async start(): Promise<number> {
    await this.loadAutomations();
    await this.automationManager.initialize();
    this.queueAutomationWrite(this.automationManager.getState());
    await this.automationWrites;
    await this.startControlServer();
    await this.startRescueServer();
    await this.writeHealth();

    this.durableConnection = this.startDurableConnection();
    process.on("message", this.handleEngineIPC);
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    const exitCode = await this.durableConnection.exited;

    this.health.lastSeenAt = new Date().toISOString();
    this.health.status = exitCode === 0 ? "closed" : "failed";
    await this.automationManager.shutdown();
    this.queueHealthWrite();
    await this.healthWrites;
    await this.automationWrites;
    await this.removeHealth();
    await this.removeAutomations();

    this.sendToEngine({
      type: "session.ended",
      from: "session",
      to: "engine",
      payload: {
        sessionId: this.health.sessionId,
        status: this.health.status,
      },
    } satisfies IpcMessage);
    await this.stopRescueServer();
    await this.stopControlServer();

    logger.info(feedback.sessionStopped, {
      sessionId: this.health.sessionId,
      sessionName: this.health.sessionName,
      status: this.health.status,
      exitCode,
    });

    return exitCode;
  }

  private async startControlServer(): Promise<void> {
    await mkdir(SESSION_CONTROL_DIRECTORY, { recursive: true });
    await rm(this.controlPath(), { force: true });

    this.controlServer = Bun.listen<SessionControlSocketData>({
      unix: this.controlPath(),
      socket: {
        open: (socket) => {
          for (const client of this.controlClients) {
            client.end();
          }
          this.controlClients.clear();

          socket.data = { buffer: "" };
          this.controlClients.add(socket);
          this.sendControlIpc(socket, {
            type: "session.health",
            from: "session",
            to: "engine",
            payload: this.health,
          } satisfies IpcMessage);
        },
        data: (socket, data) => {
          socket.data.buffer = readSessionControlFrames(
            socket.data.buffer,
            data,
            (frame) => this.handleControlFrame(frame),
          );
        },
        close: (socket) => {
          this.controlClients.delete(socket);
        },
        error: (socket, error) => {
          this.controlClients.delete(socket);
          logger.warn("Session control socket error", {
            error: getErrorMessage(error),
          });
        },
      },
    });
  }

  private startDurableConnection(): Subprocess {
    const cmd = [
      process.execPath,
      durableProcessPath,
      "--session-id",
      this.health.sessionId,
      "--durable-id",
      this.health.durableConnectionId,
      "--server-id",
      this.options.serverId,
      "--hostname",
      this.options.hostname,
      "--ip-address",
      this.options.ipAddress,
      "--port",
      String(this.port),
      "--display-name",
      this.options.sessionName,
    ];
    if (this.options.eventPassword !== undefined) {
      cmd.push("--event-password", this.options.eventPassword);
    }

    return Bun.spawn({
      cmd,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      ipc: this.handleDurableIPC,
    });
  }

  private async startRescueServer(): Promise<void> {
    await mkdir(SESSION_RESCUE_DIRECTORY, { recursive: true });
    await rm(this.rescuePath(), { force: true });

    this.rescueServer = Bun.listen<SessionRescueSocketData>({
      unix: this.rescuePath(),
      socket: {
        open: (socket) => {
          socket.data = { buffer: "" };
        },
        data: (socket, data) => {
          socket.data.buffer = readSessionRescueFrames(
            socket.data.buffer,
            data,
            (frame) => this.handleRescueFrame(socket, frame),
          );
        },
        error: (_, error) => {
          logger.warn("Session rescue socket error", {
            error: getErrorMessage(error),
          });
        },
      },
    });
    await chmod(this.rescuePath(), 0o600);
  }

  private readonly shutdown = (signal: SessionControlSignal = "SIGTERM") => {
    this.durableConnection?.kill(signal);
  };

  private handleControlFrame(frame: SessionControlFrame): void {
    switch (frame.type) {
      case "ipc":
        this.handleEngineIPC(frame.message);
        break;
      case "terminate":
        this.shutdown(frame.signal);
        break;
      default:
        break;
    }
  }

  private handleRescueFrame(
    socket: Socket<SessionRescueSocketData>,
    frame: SessionRescueFrame,
  ): void {
    if (frame.type !== "input") return;

    const result = this.handleRescueInput(frame.input);
    writeSessionRescueFrame(socket, {
      type: "result",
      ...result,
    });
  }

  private handleRescueInput(
    value: unknown,
  ): { ok: true } | { ok: false; error: string } {
    const input = parseInputPacketData(value);
    if (!input) return { ok: false, error: "Invalid input" };
    if (!this.canForwardListenerInput()) {
      return { ok: false, error: "Session is not in-world" };
    }

    const sent = this.sendToDurable({
      type: "session.input",
      from: "session",
      to: "durable-connection",
      payload: input,
    } satisfies IpcMessage);
    return sent
      ? { ok: true }
      : { ok: false, error: "Durable connection is unavailable" };
  }

  private readonly handleDurableIPC = (message: IpcMessage): void => {
    if (message.from !== "durable-connection") return;

    switch (message.type) {
      case "durable.status":
        this.health.lastSeenAt = new Date().toISOString();
        this.health.status = message.payload.status;
        this.health.ping = message.payload.ping;
        this.health.ipAddress = message.payload.ipAddress;

        this.queueHealthWrite();
        this.sendConfiguredPsk();
        break;
      case "durable.packet":
        this.forwardDurablePacket(message.payload.data);
        break;
      default:
        break;
    }
  };

  private readonly handleEngineIPC = (message: IpcMessage): void => {
    if (message.from !== "engine") return;

    switch (message.type) {
      case "engine.sync":
        if (message.payload.sessionId === this.health.sessionId) {
          this.sendSyncPackets(message.payload.listenerId);
        }
        break;
      case "engine.input":
        this.handleListenerInput(message.payload);
        break;
      case "engine.rpc":
        this.handleListenerRpc(message.payload);
        break;
      case "engine.automations.get":
        if (message.payload.sessionId === this.health.sessionId) {
          this.sendAutomationResponse(message.payload.requestId);
        }
        break;
      case "engine.automation.update":
        if (message.payload.sessionId === this.health.sessionId) {
          void this.handleAutomationUpdate(
            message.payload.requestId,
            message.payload.automationId,
            message.payload.update,
          );
        }
        break;
      default:
        break;
    }
  };

  private async handleAutomationUpdate(
    requestId: string,
    automationId: unknown,
    update: unknown,
  ): Promise<void> {
    try {
      if (!isAutomationId(automationId)) {
        throw new Error("Invalid automation");
      }
      await this.automationManager.applyUpdate(automationId, update);
      await this.automationWrites;
      this.sendAutomationResponse(requestId);
    } catch (error) {
      this.sendToEngine({
        type: "session.automations.error",
        from: "session",
        to: "engine",
        payload: {
          sessionId: this.health.sessionId,
          requestId,
          error: getErrorMessage(error),
        },
      } satisfies IpcMessage);
    }
  }

  private sendAutomationResponse(requestId: string): void {
    this.sendToEngine({
      type: "session.automations",
      from: "session",
      to: "engine",
      payload: {
        sessionId: this.health.sessionId,
        requestId,
        automations: createAutomationViews(this.automationManager.getSnapshot()),
      },
    } satisfies IpcMessage);
  }

  private handleListenerInput(packet: Uint8Array): void {
    const input = parseListenerInput(packet);
    if (!input) {
      logger.warn("Rejected invalid listener input");
      return;
    }
    if (!this.canForwardListenerInput()) return;

    this.sendToDurable({
      type: "session.input",
      from: "session",
      to: "durable-connection",
      payload: input,
    } satisfies IpcMessage);
  }

  private canForwardListenerInput(): boolean {
    return this.health.status === "in-world";
  }

  private handleListenerRpc(packet: Uint8Array): void {
    if (
      this.health.status !== "in-world" ||
      !isValidListenerRpc(packet, this.clientCodec.rpcMaps)
    ) {
      logger.warn("Rejected invalid listener RPC");
      return;
    }

    this.sendRpcPacket(packet);
  }

  private sendRpcPacket(packet: Uint8Array): boolean {
    if (
      packet.byteLength > MAX_RPC_PACKET_BYTES ||
      packet[0] !== PacketIds.PACKET_RPC
    ) {
      return false;
    }

    return this.sendToDurable({
      type: "session.rpc",
      from: "session",
      to: "durable-connection",
      payload: packet.slice(),
    } satisfies IpcMessage);
  }

  private sendConfiguredPsk(): void {
    if (
      this.pskSent ||
      !this.options.psk ||
      this.health.status !== "in-world"
    ) {
      return;
    }

    try {
      const rpc: ClientRpcData = {
        name: "JoinPartyByShareKey",
        partyShareKey: this.options.psk,
      };
      const packet = new Uint8Array(
        this.clientCodec.encode(PacketIds.PACKET_RPC, rpc),
      );
      if (packet.byteLength > MAX_RPC_PACKET_BYTES) {
        logger.warn("Configured party share key RPC exceeded packet limit");
        return;
      }

      this.pskSent = this.sendRpcPacket(packet);
    } catch (error) {
      logger.warn("Failed to send configured party share key", {
        error: getErrorMessage(error),
      });
    }
  }

  private sendToDurable(message: IpcMessage): boolean {
    if (!this.durableConnection) return false;

    try {
      this.durableConnection.send(message);
      return true;
    } catch (error) {
      logger.warn("Failed to send IPC to durable connection", {
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private forwardDurablePacket(data: ArrayBuffer): void {
    const opcode = new Uint8Array(data)[0] as number | undefined;
    if (
      opcode === PacketIds.PACKET_PRE_ENTER_WORLD ||
      opcode === PacketIds.PACKET_PING ||
      opcode === PacketIds.PACKET_BLEND
    ) {
      return;
    }

    const entityTick = readEntityTick(data);
    this.recordDurablePacket(data);

    this.sendToEngine({
      type: "durable.packet",
      from: "session",
      to: "engine",
      payload: {
        data,
        sessionId: this.health.sessionId,
        entityTick,
      },
    } satisfies IpcMessage);
  }

  private recordDurablePacket(data: ArrayBuffer): void {
    const opcode = new Uint8Array(data)[0] as PacketIds | undefined;
    if (!isSyncRecordableOpcode(opcode)) return;

    try {
      const decoded = this.clientCodec.decode(data);
      switch (opcode) {
        case PacketIds.PACKET_ENTER_WORLD:
          this.enterWorld = decoded as EnterWorldData;
          this.copyCodecSchema();
          this.sendConfiguredPsk();
          break;
        case PacketIds.PACKET_ENTITY_UPDATE: {
          const update = decoded as EntityUpdateData;
          this.recordEntityUpdate(update);
          this.automationManager.handleEntityUpdate();
          break;
        }
        case PacketIds.PACKET_RPC:
          this.recordRpcPacket(decoded as RpcData, data);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.warn("Failed to record durable packet for listener sync", {
        opcode,
        error: getErrorMessage(error),
      });
    }
  }

  private copyCodecSchema(): void {
    this.serverCodec.state.attributeMaps = this.clientCodec.attributeMaps;
    this.serverCodec.state.entityTypeNames = this.clientCodec.entityTypeNames;
    this.serverCodec.state.rpcMaps = this.clientCodec.rpcMaps;
  }

  private recordEntityUpdate(update: EntityUpdateData): void {
    this.latestTick = update.tick;

    for (const uid of Object.keys(this.clientCodec.removedEntities)) {
      const numericUid = Number(uid);
      this.entitySnapshot.delete(numericUid);
      this.entityTypesByUid.delete(numericUid);
    }

    this.refreshEntityTypes();

    for (const [uid, entity] of update.entities) {
      if (entity === true) continue;

      const entityType = this.entityTypesByUid.get(uid);
      const merged: EntityData = {
        ...(this.entitySnapshot.get(uid) ?? { uid }),
        ...entity,
      };

      if (entityType !== undefined) {
        merged.entityType = entityType;
      }

      this.entitySnapshot.set(uid, merged);
    }
  }

  private refreshEntityTypes(): void {
    this.entityTypesByUid.clear();

    for (const [entityTypeKey, uids] of Object.entries(
      this.clientCodec.sortedUidsByType,
    )) {
      const entityType = Number(entityTypeKey);
      for (const uid of uids) {
        this.entityTypesByUid.set(uid, entityType);
        const entity = this.entitySnapshot.get(uid);
        if (entity) {
          entity.entityType = entityType;
        }
      }
    }
  }

  private recordRpcPacket(packet: RpcData, data: ArrayBuffer): void {
    if (packet.name === "ReceiveChatMessage") {
      this.chatPackets.push(clonePacket(data));
      if (this.chatPackets.length > MAX_MESSAGE_HISTORY) {
        this.chatPackets.splice(0, this.chatPackets.length - MAX_MESSAGE_HISTORY);
      }
      return;
    }

    if (packet.name === "LocalBuilding") {
      this.recordLocalBuildings(packet.response);
      return;
    }

    if (packet.name === "SetItem") {
      this.recordInventoryUpdate(packet.response);
      return;
    }

    if (packet.name === "BuildingShopPrices") {
      this.recordBuildingSchema(packet.response);
    }

    if (singleSyncRpcNames.includes(packet.name as SingleSyncRpcName)) {
      this.singleRpcPackets[packet.name as SingleSyncRpcName] = clonePacket(data);
    }
  }

  private recordLocalBuildings(response: RpcData["response"]): void {
    const buildings = Array.isArray(response) ? response : [response];

    for (const building of buildings) {
      const uid = building.uid;
      if (typeof uid !== "number") continue;

      if (building.dead === 1) {
        this.localBuildingsByUid.delete(uid);
        continue;
      }

      this.localBuildingsByUid.set(uid, { ...building });
    }
  }

  private recordInventoryUpdate(response: RpcData["response"]): void {
    const items = Array.isArray(response) ? response : [response];

    for (const item of items) {
      const itemName = item.itemName;
      if (typeof itemName !== "string") continue;

      if (item.stacks === 0) {
        this.virtualInventory.delete(itemName);
        continue;
      }

      this.virtualInventory.set(itemName, { ...item });
    }
  }

  private recordBuildingSchema(response: RpcData["response"]): void {
    if (Array.isArray(response) || typeof response.json !== "string") return;

    try {
      const schema: unknown = JSON.parse(response.json);
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return;
      }
      this.buildingSchema = Object.freeze(
        structuredClone(schema as Record<string, unknown>),
      );
    } catch (error) {
      logger.warn("Failed to parse BuildingShopPrices", {
        error: getErrorMessage(error),
      });
    }
  }

  private sendSyncPackets(listenerId: string): void {
    const syncData = this.synthesizeSyncPackets();

    if (!syncData) {
      this.sendToEngine({
        type: "session.sync.unavailable",
        from: "session",
        to: "engine",
        payload: {
          sessionId: this.health.sessionId,
          listenerId,
          reason: "Session has not received enough world state yet",
        },
      } satisfies IpcMessage);
      return;
    }

    this.sendToEngine({
      type: "session.sync",
      from: "session",
      to: "engine",
      payload: {
        sessionId: this.health.sessionId,
        listenerId,
        syncData,
      },
    } satisfies IpcMessage);
  }

  private synthesizeSyncPackets(): SyncData | undefined {
    if (!this.enterWorld || this.latestTick === undefined) {
      return undefined;
    }

    try {
      const tick = this.latestTick;
      const enterWorldPacket = this.serverCodec.encodeEnterWorldResponse({
        ...this.enterWorld,
        startingTick: tick,
      });
      const freshEntityUpdatePacket = this.serverCodec.encodeFreshEntityUpdate({
        tick,
        entities: [...this.entitySnapshot.values()],
      });

      return {
        snapshotTick: tick,
        enterWorldPacket,
        freshEntityUpdatePacket,
        rpcPackets: this.synthesizeRpcPackets(),
      };
    } catch (error) {
      logger.warn("Failed to synthesize listener sync packets", {
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  private synthesizeRpcPackets(): ArrayBuffer[] {
    const packets: ArrayBuffer[] = [];

    for (const name of singleSyncRpcNames) {
      const packet = this.singleRpcPackets[name];
      if (packet) packets.push(clonePacket(packet));
    }

    packets.push(...this.synthesizeVirtualInventoryPackets());
    packets.push(...this.synthesizeLocalBuildingPackets());
    packets.push(...this.chatPackets.map(clonePacket));
    return packets;
  }

  private synthesizeVirtualInventoryPackets(): ArrayBuffer[] {
    return [...this.virtualInventory.values()].map((item) =>
      this.serverCodec.encodeRpc({
        name: "SetItem",
        response: item,
      }),
    );
  }

  private synthesizeLocalBuildingPackets(): ArrayBuffer[] {
    if (this.localBuildingsByUid.size === 0) {
      return [];
    }

    return [
      this.serverCodec.encodeRpc({
        name: "LocalBuilding",
        response: [...this.localBuildingsByUid.values()],
      }),
    ];
  }

  private createInitialAutomationState(): AutomationState {
    const state = createDefaultAutomationState();
    for (const id of this.options.automations ?? []) {
      state[id].enabled = true;
    }
    return state;
  }

  private createAutomationManager(state: unknown): AutomationManager {
    return new AutomationManager({
      state,
      context: {
        readSessionState: () =>
          Object.freeze({
            health: Object.freeze({ ...this.health }),
            playerUid: this.enterWorld?.uid,
            latestTick: this.latestTick,
            entities: Object.freeze(
              structuredClone([...this.entitySnapshot.values()]).map(
                (entity) => Object.freeze({
                  ...entity,
                  model: typeof entity.entityType === "number"
                    ? this.clientCodec.entityTypeNames[entity.entityType]
                    : entity.model,
                }),
              ),
            ),
            buildings: Object.freeze(
              structuredClone([...this.localBuildingsByUid.values()]).map(
                (building) => {
                  const uid = building.uid;
                  const entity = typeof uid === "number"
                    ? this.entitySnapshot.get(uid)
                    : undefined;
                  const yaw = entity?.yaw;
                  return Object.freeze({
                    ...building,
                    ...(typeof yaw === "number" ? { yaw } : {}),
                  });
                },
              ),
            ),
            buildingSchema: Object.freeze(structuredClone(this.buildingSchema)),
          }),
        sendInput: (input) => {
          if (this.health.status !== "in-world") return;
          const packet = new Uint8Array(
            this.clientCodec.encode(PacketIds.PACKET_INPUT, input),
          );
          const parsed = parseListenerInput(packet);
          if (!parsed) throw new Error("Automation produced invalid input");
          this.sendToDurable({
            type: "session.input",
            from: "session",
            to: "durable-connection",
            payload: parsed,
          } satisfies IpcMessage);
        },
        sendRpc: (name, payload) => {
          if (this.health.status !== "in-world") return;
          const rpc: ClientRpcData = { name };
          for (const [key, value] of Object.entries(payload)) {
            if (typeof value !== "string" && typeof value !== "number") {
              throw new Error("Automation produced an invalid RPC");
            }
            rpc[key] = value;
          }
          const packet = new Uint8Array(
            this.clientCodec.encode(PacketIds.PACKET_RPC, rpc),
          );
          if (!this.sendRpcPacket(packet)) {
            throw new Error("Automation RPC was rejected");
          }
        },
        log: (message) =>
          logger.info(message, {
            sessionId: this.health.sessionId,
          }),
      },
      onChange: (automationState) => {
        this.queueAutomationWrite(automationState);
      },
    });
  }

  private async loadAutomations(): Promise<void> {
    const path = `${AUTOMATION_DIRECTORY}/${this.health.sessionId}.json`;
    const content = await readFile(path, "utf8").catch(() => undefined);
    let state: unknown = this.createInitialAutomationState();
    if (content) {
      try {
        state = JSON.parse(content);
      } catch (error) {
        logger.warn("Failed to read persisted automations", {
          sessionId: this.health.sessionId,
          error: getErrorMessage(error),
        });
      }
    }
    this.automationManager = this.createAutomationManager(state);
  }

  private queueAutomationWrite(state: AutomationState): void {
    const snapshot = structuredClone(state);
    this.automationWrites = this.automationWrites
      .then(() => this.writeAutomations(snapshot))
      .catch((error) => {
        logger.warn("Failed to persist session automations", {
          sessionId: this.health.sessionId,
          error: getErrorMessage(error),
        });
      });
  }

  private async writeAutomations(state: AutomationState): Promise<void> {
    await mkdir(AUTOMATION_DIRECTORY, { recursive: true });
    const path = `${AUTOMATION_DIRECTORY}/${this.health.sessionId}.json`;
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporaryPath, JSON.stringify(state, null, 2));
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async removeAutomations(): Promise<void> {
    await rm(`${AUTOMATION_DIRECTORY}/${this.health.sessionId}.json`, {
      force: true,
    });
  }

  private queueHealthWrite(): void {
    const snapshot = { ...this.health };
    this.healthWrites = this.healthWrites
      .then(() => this.writeHealth(snapshot))
      .catch((error) => {
        logger.warn("Failed to persist session health", {
          error: getErrorMessage(error),
        });
      });
  }

  private async writeHealth(health: SessionHealth = this.health): Promise<void> {
    await mkdir(".sessions", { recursive: true });
    await Bun.write(
      `.sessions/${health.sessionId}.json`,
      JSON.stringify(health, null, 2),
    );

    this.sendToEngine({
      type: "session.health",
      from: "session",
      to: "engine",
      payload: health,
    } satisfies IpcMessage);
  }

  private async removeHealth(): Promise<void> {
    await rm(`.sessions/${this.health.sessionId}.json`, { force: true });
  }

  private controlPath(): string {
    return getSessionControlPath(this.health.sessionId);
  }

  private rescuePath(): string {
    return getSessionRescuePath(this.health.sessionId);
  }

  private sendToEngine(message: IpcMessage): void {
    try {
      parent.send?.(message);
    } catch {
      // Parent IPC disappears when the engine is restarted; the control socket
      // keeps live sessions manageable without disturbing the durable socket.
    }

    for (const client of [...this.controlClients]) {
      this.sendControlIpc(client, message);
    }
  }

  private sendControlIpc(
    socket: Socket<SessionControlSocketData>,
    message: IpcMessage,
  ): void {
    if (writeSessionControlFrame(socket, { type: "ipc", message })) return;

    this.controlClients.delete(socket);
    socket.end();
  }

  private async stopControlServer(): Promise<void> {
    for (const client of this.controlClients) {
      client.end();
    }
    this.controlClients.clear();
    this.controlServer?.stop(true);
    this.controlServer = undefined;
    await rm(this.controlPath(), { force: true });
  }

  private async stopRescueServer(): Promise<void> {
    this.rescueServer?.stop(true);
    this.rescueServer = undefined;
    await rm(this.rescuePath(), { force: true });
  }
}

function clonePacket(packet: ArrayBuffer): ArrayBuffer {
  return packet.slice(0);
}

export function readEntityTick(packet: ArrayBuffer): number | undefined {
  if (
    packet.byteLength < 5 ||
    new Uint8Array(packet, 0, 1)[0] !== PacketIds.PACKET_ENTITY_UPDATE
  ) {
    return undefined;
  }

  return new DataView(packet).getUint32(1, true);
}

function isSyncRecordableOpcode(opcode: PacketIds | undefined): boolean {
  return (
    opcode === PacketIds.PACKET_ENTER_WORLD ||
    opcode === PacketIds.PACKET_ENTITY_UPDATE ||
    opcode === PacketIds.PACKET_RPC
  );
}
