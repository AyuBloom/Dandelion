import ByteBuffer from "bytebuffer";
import { AttributeType, PacketIds, ParameterType } from "./enums.ts";
import { DandelionError } from "../shared/errors.ts";
import type {
  AttributeMapEntry,
  EntityAttributeValue,
  EntityData,
  EntityUpdateData,
  EnterWorldData,
  RpcData,
  RpcMapEntry,
  RpcObject,
  RpcParameterEntry,
  Vector2,
} from "../shared/packets.ts";

const UINT32_SIZE = 4294967296;
const DEFAULT_BUFFER_SIZE = 4096;

export interface ServerCodecState {
  attributeMaps: Record<number, AttributeMapEntry[]>;
  entityTypeNames: Record<number, string>;
  rpcMaps: RpcMapEntry[];
  sortedUidsByType: Record<number, number[]>;
}

export type EntityTypeLookup = Map<number, number> | Record<number, number>;

export interface ServerEntityUpdateData
  extends Omit<EntityUpdateData, "entities"> {
  entities: Map<number, EntityData | true>;
  entityTypes?: EntityTypeLookup;
  removedUids?: Iterable<number>;
}

export interface ServerFreshEntityUpdateData
  extends Pick<EntityUpdateData, "tick"> {
  entities: EntityData[];
}

export function createServerCodecState(
  state: Partial<ServerCodecState> = {},
): ServerCodecState {
  return {
    attributeMaps: state.attributeMaps ?? {},
    entityTypeNames: state.entityTypeNames ?? {},
    rpcMaps: state.rpcMaps ?? [],
    sortedUidsByType: state.sortedUidsByType ?? {},
  };
}

export class ServerCodec {
  readonly state: ServerCodecState;

  constructor(state: Partial<ServerCodecState> = {}) {
    this.state = createServerCodecState(state);
  }

  encodePing(): ArrayBuffer {
    const buffer = createPacketBuffer(PacketIds.PACKET_PING);
    return finishPacketBuffer(buffer);
  }

  encodeEnterWorldResponse(item: EnterWorldData): ArrayBuffer {
    const buffer = createPacketBuffer(PacketIds.PACKET_ENTER_WORLD);

    buffer.writeUint32(item.allowed);
    buffer.writeUint32(item.uid);
    buffer.writeUint32(item.startingTick);
    buffer.writeUint32(item.tickRate);
    buffer.writeUint32(item.effectiveTickRate);
    buffer.writeUint32(item.players);
    buffer.writeUint32(item.maxPlayers);
    buffer.writeUint32(item.chatChannel);
    buffer.writeVString(item.effectiveDisplayName);
    buffer.writeInt32(item.x1);
    buffer.writeInt32(item.y1);
    buffer.writeInt32(item.x2);
    buffer.writeInt32(item.y2);

    const entityTypes = getSortedEntityTypes(this.state.attributeMaps);
    buffer.writeUint32(entityTypes.length);
    this.state.sortedUidsByType = {};

    for (const entityType of entityTypes) {
      const attributeMap = this.state.attributeMaps[entityType];
      const entityTypeName = this.state.entityTypeNames[entityType];

      if (!attributeMap) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Missing attribute map for entity type: ${entityType}`);
      }
      if (entityTypeName === undefined) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Missing entity type name for entity type: ${entityType}`);
      }

      buffer.writeUint32(entityType);
      buffer.writeVString(entityTypeName);
      buffer.writeUint32(attributeMap.length);
      this.state.sortedUidsByType[entityType] = [];

      for (const attribute of attributeMap) {
        buffer.writeVString(attribute.name);
        buffer.writeUint32(attribute.type);
      }
    }

    const rpcMaps = getRpcMapsByIndex(this.state.rpcMaps);
    buffer.writeUint32(rpcMaps.length);

    for (const rpc of rpcMaps) {
      buffer.writeVString(rpc.name);
      buffer.writeUint8(rpc.parameters.length);
      buffer.writeUint8(rpc.isArray ? 1 : 0);

      for (const parameter of rpc.parameters) {
        buffer.writeVString(parameter.name);
        buffer.writeUint8(parameter.type);
      }
    }

    return finishPacketBuffer(buffer);
  }

  encodeRpc(item: RpcData): ArrayBuffer {
    const rpc = findRpcByName(this.state, item.name);
    const buffer = createPacketBuffer(PacketIds.PACKET_RPC);

    buffer.writeUint32(rpc.index);

    if (rpc.isArray) {
      if (!Array.isArray(item.response)) {
        throw new DandelionError("SERVER_CODEC_ERROR", `RPC ${item.name} expects an array response`);
      }

      buffer.writeUint16(item.response.length);
      for (const response of item.response) {
        writeRpcObject(buffer, rpc.parameters, response, item.name);
      }

      return finishPacketBuffer(buffer);
    }

    if (Array.isArray(item.response)) {
      throw new DandelionError("SERVER_CODEC_ERROR", `RPC ${item.name} expects an object response`);
    }

    writeRpcObject(buffer, rpc.parameters, item.response, item.name);
    return finishPacketBuffer(buffer);
  }

  encodeEntityUpdate(item: ServerEntityUpdateData): ArrayBuffer {
    const buffer = createPacketBuffer(PacketIds.PACKET_ENTITY_UPDATE);
    const knownEntityTypes = getKnownEntityTypes(this.state);
    const removedUids = [...new Set(item.removedUids ?? [])];
    const removedUidSet = new Set(removedUids);
    const newUidsByType = new Map<number, number[]>();
    const sectionTypes = new Set<number>();

    buffer.writeUint32(item.tick);
    buffer.writeVarint32(removedUids.length);
    for (const uid of removedUids) {
      buffer.writeUint32(assertUint32(uid, "removed entity uid"));
    }

    for (const [uid, entity] of item.entities) {
      if (removedUidSet.has(uid)) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Entity ${uid} cannot be removed and updated in one packet`);
      }

      const entityType = getEntityTypeForUpdate(
        uid,
        entity,
        item.entityTypes,
        knownEntityTypes,
      );

      if (entityType === undefined) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Missing entity type for entity uid: ${uid}`);
      }

      sectionTypes.add(entityType);

      if (!knownEntityTypes.has(uid)) {
        if (entity === true) {
          throw new DandelionError("SERVER_CODEC_ERROR", `New entity ${uid} cannot be encoded as absent`);
        }
        pushGroupedUid(newUidsByType, entityType, uid);
        knownEntityTypes.set(uid, entityType);
      }
    }

    buffer.writeVarint32(newUidsByType.size);
    for (const [entityType, uids] of newUidsByType) {
      buffer.writeVarint32(uids.length);
      buffer.writeUint32(entityType);

      for (const uid of uids) {
        buffer.writeUint32(assertUint32(uid, "new entity uid"));
      }
    }

    applyEntityTableChanges(this.state, removedUidSet, newUidsByType);

    for (const entityType of sectionTypes) {
      const sortedUids = this.state.sortedUidsByType[entityType];
      const attributeMap = this.state.attributeMaps[entityType];

      if (!sortedUids || !attributeMap) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Entity type is not in attribute map: ${entityType}`);
      }

      buffer.writeUint32(entityType);
      writeAbsentEntityFlags(buffer, sortedUids, item.entities);

      for (const uid of sortedUids) {
        const entity = item.entities.get(uid);
        if (entity === undefined || entity === true) continue;

        writeEntityAttributeFlags(buffer, attributeMap, entity);
        for (const attribute of attributeMap) {
          if (hasOwn(entity, attribute.name)) {
            writeAttributeValue(buffer, attribute, entity[attribute.name]);
          }
        }
      }
    }

    return finishPacketBuffer(buffer);
  }

  encodeFreshEntityUpdate(item: ServerFreshEntityUpdateData): ArrayBuffer {
    const entities = new Map<number, EntityData | true>();

    for (const entity of item.entities) {
      const uid = assertUint32(entity.uid, "fresh entity uid");
      if (entities.has(uid)) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Duplicate fresh entity uid: ${uid}`);
      }

      const entityType = getInlineEntityType(entity);
      if (entityType === undefined) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Missing entity type for fresh entity uid: ${uid}`);
      }

      const attributeMap = this.state.attributeMaps[assertUint32(entityType, "entity type")];
      if (!attributeMap) {
        throw new DandelionError("SERVER_CODEC_ERROR", `Entity type is not in attribute map: ${entityType}`);
      }

      assertEntityHasAllAttributes(entity, attributeMap);
      entities.set(uid, entity);
    }

    const previousSortedUidsByType = this.state.sortedUidsByType;
    this.state.sortedUidsByType = createEmptyUidTable(this.state.attributeMaps);

    try {
      return this.encodeEntityUpdate({
        tick: item.tick,
        byteSize: 0,
        entities,
      });
    } catch (error) {
      this.state.sortedUidsByType = previousSortedUidsByType;
      throw error;
    }
  }
}

function createPacketBuffer(opcode: PacketIds): ByteBuffer {
  const buffer = new ByteBuffer(DEFAULT_BUFFER_SIZE, true);
  buffer.writeUint8(opcode);
  return buffer;
}

function finishPacketBuffer(buffer: ByteBuffer): ArrayBuffer {
  buffer.flip();
  buffer.compact();
  return buffer.toArrayBuffer(false);
}

function getSortedEntityTypes(
  attributeMaps: Record<number, AttributeMapEntry[]>,
): number[] {
  return Object.keys(attributeMaps)
    .map(Number)
    .sort((a, b) => a - b);
}

function getRpcMapsByIndex(rpcMaps: RpcMapEntry[]): RpcMapEntry[] {
  return [...rpcMaps].sort((a, b) => a.index - b.index);
}

function findRpcByName(state: ServerCodecState, name: string): RpcMapEntry {
  const rpc = state.rpcMaps.find((entry) => entry.name === name);
  if (!rpc) throw new DandelionError("SERVER_CODEC_ERROR", `RPC not in map: ${name}`);
  return rpc;
}

function writeRpcObject(
  buffer: ByteBuffer,
  parameters: RpcParameterEntry[],
  response: RpcObject,
  rpcName: string,
): void {
  for (const parameter of parameters) {
    const value = response[parameter.name];
    if (value === undefined) {
      throw new DandelionError("SERVER_CODEC_ERROR", `Missing RPC parameter ${rpcName}.${parameter.name}`);
    }
    writeParameterValue(buffer, parameter, value);
  }
}

function writeParameterValue(
  buffer: ByteBuffer,
  parameter: RpcParameterEntry,
  value: EntityAttributeValue,
): void {
  switch (parameter.type) {
    case ParameterType.Uint32:
      buffer.writeUint32(assertUint32(value, parameter.name));
      break;
    case ParameterType.Int32:
      buffer.writeInt32(assertInt32(value, parameter.name));
      break;
    case ParameterType.Float:
      buffer.writeInt32(toFixedHundredths(value, parameter.name));
      break;
    case ParameterType.String:
      buffer.writeVString(String(value));
      break;
    case ParameterType.Uint64:
      writeUint64(buffer, assertSafeInteger(value, parameter.name));
      break;
    case ParameterType.Int64:
      writeInt64(buffer, assertSafeInteger(value, parameter.name));
      break;
    default:
      throw new DandelionError("SERVER_CODEC_ERROR", `Unsupported parameter type: ${parameter.type}`);
  }
}

function writeAttributeValue(
  buffer: ByteBuffer,
  attribute: AttributeMapEntry,
  value: EntityAttributeValue | undefined,
): void {
  if (value === undefined) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Missing entity attribute: ${attribute.name}`);
  }

  switch (attribute.type) {
    case AttributeType.Uint32:
    case AttributeType.EntityType:
      buffer.writeUint32(assertUint32(value, attribute.name));
      break;
    case AttributeType.Int32:
      buffer.writeInt32(assertInt32(value, attribute.name));
      break;
    case AttributeType.Float:
      buffer.writeInt32(toFixedHundredths(value, attribute.name));
      break;
    case AttributeType.String:
      buffer.writeVString(String(value));
      break;
    case AttributeType.Vector2:
      writeVector2(buffer, value, attribute.name);
      break;
    case AttributeType.ArrayVector2:
      writeVector2Array(buffer, value, attribute.name);
      break;
    case AttributeType.ArrayUint32:
      writeUint32Array(buffer, value, attribute.name);
      break;
    case AttributeType.Uint16:
      buffer.writeUint16(assertUint16(value, attribute.name));
      break;
    case AttributeType.Uint8:
      buffer.writeUint8(assertUint8(value, attribute.name));
      break;
    case AttributeType.Int16:
      buffer.writeInt16(assertInt16(value, attribute.name));
      break;
    case AttributeType.Int8:
      buffer.writeInt8(assertInt8(value, attribute.name));
      break;
    case AttributeType.Uint64:
      writeUint64(buffer, assertSafeInteger(value, attribute.name));
      break;
    case AttributeType.Int64:
      writeInt64(buffer, assertSafeInteger(value, attribute.name));
      break;
    case AttributeType.Double:
      writeInt64(buffer, toFixedHundredths(value, attribute.name));
      break;
    default:
      throw new DandelionError("SERVER_CODEC_ERROR", `Unsupported attribute type: ${attribute.type}`);
  }
}

function writeEntityAttributeFlags(
  buffer: ByteBuffer,
  attributeMap: AttributeMapEntry[],
  entity: EntityData,
): void {
  const flagsLength = Math.ceil(attributeMap.length / 8);
  const flags = new Array<number>(flagsLength).fill(0);

  for (let i = 0; i < attributeMap.length; i++) {
    const attribute = attributeMap[i]!;
    if (!hasOwn(entity, attribute.name)) continue;

    flags[Math.floor(i / 8)]! |= 1 << (i % 8);
  }

  for (const flag of flags) {
    buffer.writeUint8(flag);
  }
}

function writeAbsentEntityFlags(
  buffer: ByteBuffer,
  sortedUids: number[],
  entities: Map<number, EntityData | true>,
): void {
  const flagsLength = Math.floor((sortedUids.length + 7) / 8);
  const flags = new Array<number>(flagsLength).fill(0);

  for (let i = 0; i < sortedUids.length; i++) {
    const entity = entities.get(sortedUids[i]!);
    if (entity !== undefined && entity !== true) continue;

    flags[Math.floor(i / 8)]! |= 1 << (i % 8);
  }

  for (const flag of flags) {
    buffer.writeUint8(flag);
  }
}

function applyEntityTableChanges(
  state: ServerCodecState,
  removedUids: Set<number>,
  newUidsByType: Map<number, number[]>,
): void {
  for (const entityType of getSortedEntityTypes(state.attributeMaps)) {
    const sortedUids = state.sortedUidsByType[entityType] ?? [];
    const newUids = newUidsByType.get(entityType) ?? [];
    state.sortedUidsByType[entityType] = [...sortedUids, ...newUids]
      .filter((uid) => !removedUids.has(uid))
      .sort((a, b) => a - b);
  }
}

function createEmptyUidTable(
  attributeMaps: Record<number, AttributeMapEntry[]>,
): Record<number, number[]> {
  const sortedUidsByType: Record<number, number[]> = {};

  for (const entityType of getSortedEntityTypes(attributeMaps)) {
    sortedUidsByType[entityType] = [];
  }

  return sortedUidsByType;
}

function assertEntityHasAllAttributes(
  entity: EntityData,
  attributeMap: AttributeMapEntry[],
): void {
  for (const attribute of attributeMap) {
    if (!hasOwn(entity, attribute.name)) {
      throw new DandelionError("SERVER_CODEC_ERROR", 
        `Missing fresh entity ${entity.uid} attribute: ${attribute.name}`,
      );
    }
  }
}

function getKnownEntityTypes(state: ServerCodecState): Map<number, number> {
  const result = new Map<number, number>();

  for (const [entityTypeString, sortedUids] of Object.entries(state.sortedUidsByType)) {
    const entityType = Number(entityTypeString);
    for (const uid of sortedUids) {
      result.set(uid, entityType);
    }
  }

  return result;
}

function getEntityTypeForUpdate(
  uid: number,
  entity: EntityData | true,
  entityTypes: EntityTypeLookup | undefined,
  knownEntityTypes: Map<number, number>,
): number | undefined {
  return (
    knownEntityTypes.get(uid) ??
    getEntityTypeFromLookup(entityTypes, uid) ??
    getInlineEntityType(entity)
  );
}

function getEntityTypeFromLookup(
  entityTypes: EntityTypeLookup | undefined,
  uid: number,
): number | undefined {
  if (!entityTypes) return undefined;
  if (entityTypes instanceof Map) return entityTypes.get(uid);

  const entityType = entityTypes[uid];
  return typeof entityType === "number" ? entityType : undefined;
}

function getInlineEntityType(entity: EntityData | true): number | undefined {
  if (entity === true) return undefined;

  const entityType = entity["entityType"];
  return typeof entityType === "number" ? entityType : undefined;
}

function pushGroupedUid(
  groups: Map<number, number[]>,
  entityType: number,
  uid: number,
): void {
  const uids = groups.get(entityType);
  if (uids) {
    uids.push(uid);
    return;
  }

  groups.set(entityType, [uid]);
}

function writeVector2(
  buffer: ByteBuffer,
  value: EntityAttributeValue,
  context: string,
): void {
  const vector = assertVector2(value, context);

  buffer.writeInt32(toFixedHundredths(vector.x, `${context}.x`));
  buffer.writeInt32(toFixedHundredths(vector.y, `${context}.y`));
}

function writeVector2Array(
  buffer: ByteBuffer,
  value: EntityAttributeValue,
  context: string,
): void {
  if (!Array.isArray(value)) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Expected Vector2[] for ${context}`);
  }
  const vectors = value.map((vector) => assertVector2(vector, context, "Vector2[]"));

  buffer.writeInt32(vectors.length);
  for (const vector of vectors) {
    buffer.writeInt32(toFixedHundredths(vector.x, `${context}.x`));
    buffer.writeInt32(toFixedHundredths(vector.y, `${context}.y`));
  }
}

function writeUint32Array(
  buffer: ByteBuffer,
  value: EntityAttributeValue,
  context: string,
): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Expected number[] for ${context}`);
  }

  buffer.writeInt32(value.length);
  for (const item of value) {
    buffer.writeInt32(assertInt32(item, context));
  }
}

function writeUint64(buffer: ByteBuffer, value: number): void {
  const high = Math.floor(value / UINT32_SIZE);
  const low = value - high * UINT32_SIZE;

  buffer.writeUint32(low);
  buffer.writeUint32(high);
}

function writeInt64(buffer: ByteBuffer, value: number): void {
  if (value >= 0) {
    writeUint64(buffer, value);
    return;
  }

  const high = Math.ceil(value / UINT32_SIZE);
  const low = high * UINT32_SIZE - value;

  if (high >= 0 || low < 0 || low > 0xffffffff || !Number.isInteger(low)) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Int64 value cannot round-trip through readInt64: ${value}`);
  }

  buffer.writeUint32(low);
  buffer.writeInt32(high);
}

function toFixedHundredths(value: EntityAttributeValue, context: string): number {
  return assertInt32(Math.floor(assertNumber(value, context) * 100), context);
}

function assertUint32(value: EntityAttributeValue, context: string): number {
  return assertIntegerInRange(value, context, 0, 0xffffffff);
}

function assertUint16(value: EntityAttributeValue, context: string): number {
  return assertIntegerInRange(value, context, 0, 0xffff);
}

function assertUint8(value: EntityAttributeValue, context: string): number {
  return assertIntegerInRange(value, context, 0, 0xff);
}

function assertInt32(value: EntityAttributeValue, context: string): number {
  return assertIntegerInRange(value, context, -0x80000000, 0x7fffffff);
}

function assertInt16(value: EntityAttributeValue, context: string): number {
  return assertIntegerInRange(value, context, -0x8000, 0x7fff);
}

function assertInt8(value: EntityAttributeValue, context: string): number {
  return assertIntegerInRange(value, context, -0x80, 0x7f);
}

function assertSafeInteger(value: EntityAttributeValue, context: string): number {
  const number = assertNumber(value, context);
  if (!Number.isSafeInteger(number) || number < Number.MIN_SAFE_INTEGER) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Expected safe integer for ${context}`);
  }
  return number;
}

function assertIntegerInRange(
  value: EntityAttributeValue,
  context: string,
  min: number,
  max: number,
): number {
  const number = assertNumber(value, context);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Expected integer ${min}..${max} for ${context}`);
  }
  return number;
}

function assertNumber(value: EntityAttributeValue, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DandelionError("SERVER_CODEC_ERROR", `Expected number for ${context}`);
  }
  return value;
}

function assertVector2(
  value: unknown,
  context: string,
  expectedType = "Vector2",
): Vector2 {
  const vector = value as Partial<Vector2>;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof vector.x === "number" &&
    typeof vector.y === "number"
  ) {
    return vector as Vector2;
  }

  throw new DandelionError("SERVER_CODEC_ERROR", `Expected ${expectedType} for ${context}`);
}

function hasOwn(object: EntityData, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
