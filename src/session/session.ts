import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

import { PacketIds } from "../network/enums.ts";
import { ServerCodec } from "../network/server-codec.ts";
import { getErrorMessage } from "../shared/errors.ts";
import type { IpcMessage, SessionHealth, SyncData } from "../shared/ipc.ts";
import { logger } from "../shared/logger.ts";
import type { SessionId } from "../shared/ids.ts";
import type {
  ClientRpcData,
  EntityData,
  EntityUpdateData,
  EnterWorldData,
  RpcData,
  RpcObject,
} from "../shared/packets.ts";
import MiniCodec from "../network/mini-codec.ts";
import { parseListenerInput } from "./input.ts";
import { isValidListenerRpc, MAX_RPC_PACKET_BYTES } from "./rpc.ts";

export interface SessionOptions {
  sessionId: SessionId;
  sessionName: string;
  server: string;
  psk?: string;
}

const MAX_MESSAGE_HISTORY = 500;

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
  private clientCodec: MiniCodec;
  private serverCodec: ServerCodec;
  private enterWorld?: EnterWorldData;
  private latestTick?: number;
  private readonly entitySnapshot = new Map<number, EntityData>();
  private readonly entityTypesByUid = new Map<number, number>();
  private readonly singleRpcPackets: Partial<Record<SingleSyncRpcName, ArrayBuffer>> = {};
  private readonly chatPackets: ArrayBuffer[] = [];
  private readonly localBuildingsByUid = new Map<number, RpcObject>();
  private healthWrites = Promise.resolve();
  private pskSent = false;

  constructor(private readonly options: SessionOptions) {
    const createdAt = new Date().toISOString();

    this.health = {
      sessionId: options.sessionId,
      durableConnectionId: crypto.randomUUID(),
      sessionName: options.sessionName,
      createdAt,
      lastSeenAt: createdAt,
      hostname: options.server,
      status: "booting",
    };

    this.clientCodec = new MiniCodec();
    this.serverCodec = new ServerCodec();
  }

  async start(): Promise<number> {
    await this.writeHealth();

    this.durableConnection = this.startDurableConnection();
    process.on("message", this.handleEngineIPC);
    process.on("SIGINT", this.shutdown);
    process.on("SIGTERM", this.shutdown);

    const exitCode = await this.durableConnection.exited;

    this.health.lastSeenAt = new Date().toISOString();
    this.health.status = exitCode === 0 ? "closed" : "failed";
    this.queueHealthWrite();
    await this.healthWrites;
    await this.removeHealth();

    parent.send?.({
      type: "session.ended",
      from: "session",
      to: "engine",
      payload: {
        sessionId: this.health.sessionId,
        status: this.health.status,
      },
    } satisfies IpcMessage);

    logger.info("Session process stopped", {
      sessionId: this.health.sessionId,
      exitCode,
    });

    return exitCode;
  }

  private startDurableConnection(): Subprocess {
    return Bun.spawn({
      cmd: [
        process.execPath,
        durableProcessPath,
        "--session-id",
        this.health.sessionId,
        "--durable-id",
        this.health.durableConnectionId,
        "--hostname",
        this.options.server,
        "--display-name",
        this.options.sessionName,
      ],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      ipc: this.handleDurableIPC,
    });
  }

  private readonly shutdown = () => {
    this.durableConnection?.kill("SIGTERM");
  };

  private readonly handleDurableIPC = (message: IpcMessage): void => {
    if (message.from !== "durable-connection") return;

    switch (message.type) {
      case "durable.status":
        this.health.lastSeenAt = new Date().toISOString();
        this.health.status = message.payload.status;
        this.health.ping = message.payload.ping;

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
      default:
        break;
    }
  };

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
    if (opcode === PacketIds.PACKET_PING || opcode === PacketIds.PACKET_BLEND) {
      return;
    }

    const entityTick = readEntityTick(data);
    this.recordDurablePacket(data);

    parent.send?.({
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

  private sendSyncPackets(listenerId: string): void {
    const syncData = this.synthesizeSyncPackets();

    if (!syncData) {
      parent.send?.({
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

    parent.send?.({
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

    packets.push(...this.synthesizeLocalBuildingPackets());
    packets.push(...this.chatPackets.map(clonePacket));
    return packets;
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

    parent.send?.({
      type: "session.health",
      from: "session",
      to: "engine",
      payload: health,
    } satisfies IpcMessage);
  }

  private async removeHealth(): Promise<void> {
    await rm(`.sessions/${this.health.sessionId}.json`, { force: true });
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
