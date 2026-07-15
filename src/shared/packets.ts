import type { AttributeType, PacketIds, ParameterType } from "../network/enums.ts";

export interface AttributeMapEntry {
  name: string;
  type: AttributeType;
}

export interface RpcParameterEntry {
  name: string;
  type: ParameterType;
}

export interface RpcMapEntry {
  name: string;
  parameters: RpcParameterEntry[];
  isArray: boolean;
  index: number;
}

export interface Vector2 {
  x: number;
  y: number;
}

export type EntityAttributeValue = number | string | Vector2 | Vector2[] | number[];

export interface EntityData {
  uid: number;
  [attributeName: string]: EntityAttributeValue;
}

export interface PreEnterWorldData {
  opcode?: PacketIds.PACKET_PRE_ENTER_WORLD;
  extra: ArrayBuffer;
}

export interface EnterWorldData {
  opcode?: PacketIds.PACKET_ENTER_WORLD;
  allowed: number;
  uid: number;
  startingTick: number;
  tickRate: number;
  effectiveTickRate: number;
  players: number;
  maxPlayers: number;
  chatChannel: number;
  effectiveDisplayName: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface EntityUpdateData {
  opcode?: PacketIds.PACKET_ENTITY_UPDATE;
  tick: number;
  entities: Map<number, EntityData | true>;
  byteSize: number;
}

export interface PingData {
  opcode?: PacketIds.PACKET_PING;
}

export interface RpcData {
  opcode?: PacketIds.PACKET_RPC;
  name: string;
  response: RpcObject | RpcObject[];
}

export interface BlendData {
  opcode?: PacketIds.PACKET_BLEND;
  extra: ArrayBuffer;
}

export type DecodedPacket =
  | PreEnterWorldData
  | EnterWorldData
  | EntityUpdateData
  | PingData
  | RpcData
  | BlendData;

export interface ClientRpcData {
  name: string;
  [parameter: string]: string | number;
}

export interface EnterWorldRequest {
  displayName: string;
  extra: ArrayBuffer;
}

export interface BlendRequest {
  extra: ArrayBuffer;
}

export interface InputPacketData {
  respawn?: number;
  up?: number;
  down?: number;
  left?: number;
  right?: number;
  space?: number;
  mouseDown?: number;
  mouseUp?: number;
  mouseMoved?: number;
  mouseMovedWhileDown?: number;
  worldX?: number;
  worldY?: number;
  distance?: number;
}

export type RpcObject = Record<string, EntityAttributeValue>;
export type EncodablePacket =
  | EnterWorldRequest
  | ClientRpcData
  | BlendRequest
  | InputPacketData;
