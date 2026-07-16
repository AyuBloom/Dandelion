import type {
  AutomationId,
  AutomationUpdate,
  AutomationView,
} from "../automations/automations.ts";
import type { DurableConnectionId, ListenerId, SessionId } from "../shared/ids";
import type { InputPacketData } from "./packets";

// only these three can communicate with IPC
export type ProcessRole = "engine" | "session" | "durable-connection";

export type DurableConnectionStatus =
  | "booting"
  | "connecting"
  | "waiting-pre-enter"
  | "waiting-enter-world"
  | "in-world"
  | "closing"
  | "closed"
  | "failed";

export interface IpcEnvelope<TType extends string, TPayload> {
  type: TType;
  from: ProcessRole;
  to?: ProcessRole;
  payload: TPayload;
}

export interface SessionHealth {
  sessionId: SessionId;
  durableConnectionId: DurableConnectionId;
  sessionName: string;
  createdAt: string;
  lastSeenAt: string;
  serverId: string;
  hostname: string;
  ipAddress: string;
  status: DurableConnectionStatus;
  ping?: number;
}

export interface SyncData {
  snapshotTick: number;
  enterWorldPacket: ArrayBuffer;
  freshEntityUpdatePacket: ArrayBuffer;
  rpcPackets: ArrayBuffer[];
}

export type IpcMessage =
  | IpcEnvelope<"durable.status", {
    sessionId: SessionId;
    durableConnectionId: DurableConnectionId;
    serverId: string;
    hostname: string;
    ipAddress: string;
    status: DurableConnectionStatus;
    ping?: number;
    error?: string;
  }>
  | IpcEnvelope<"durable.packet", {
    data: ArrayBuffer;
    sessionId: SessionId;
    entityTick?: number;
  }>
  | IpcEnvelope<"session.sync", {
    sessionId: SessionId;
    listenerId: ListenerId;
    syncData: SyncData;
  }>
  | IpcEnvelope<"session.sync.unavailable", {
    sessionId: SessionId;
    listenerId: ListenerId;
    reason: string;
  }>
  | IpcEnvelope<"session.health", SessionHealth>
  | IpcEnvelope<"session.ended", {
    sessionId: SessionId;
    status: "closed" | "failed";
  }>
  | IpcEnvelope<"engine.sync", {
    sessionId: SessionId;
    listenerId: ListenerId;
  }>
  | IpcEnvelope<"engine.input", Uint8Array>
  | IpcEnvelope<"engine.rpc", Uint8Array>
  | IpcEnvelope<"engine.automations.get", {
    sessionId: SessionId;
    requestId: string;
  }>
  | IpcEnvelope<"engine.automation.update", {
    sessionId: SessionId;
    requestId: string;
    automationId: AutomationId;
    update: AutomationUpdate;
  }>
  | IpcEnvelope<"session.automations", {
    sessionId: SessionId;
    requestId: string;
    automations: AutomationView[];
  }>
  | IpcEnvelope<"session.automations.error", {
    sessionId: SessionId;
    requestId: string;
    error: string;
  }>
  | IpcEnvelope<"session.input", InputPacketData>
  | IpcEnvelope<"session.rpc", Uint8Array>;
