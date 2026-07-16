import ByteBuffer from "bytebuffer";
import { AttributeType, PacketIds, ParameterType } from "./enums.ts";
import {
  readInt64,
  readUint64,
  readVarint32,
  readVector2,
  safeReadVString,
} from "./helpers.ts";
import { DandelionError } from "../shared/errors.ts";
import type {
  AttributeMapEntry,
  ClientRpcData,
  DecodedPacket,
  EncodablePacket,
  EntityAttributeValue,
  EntityData,
  EntityUpdateData,
  EnterWorldData,
  EnterWorldRequest,
  InputPacketData,
  PingData,
  RpcData,
  RpcMapEntry,
  RpcObject,
  RpcParameterEntry,
  Vector2,
} from "../shared/packets.ts";

type SortedUidTable = Record<number, Uint32Array>;

class MiniCodec {
  attributeMaps: Record<number, AttributeMapEntry[]>;
  entityTypeNames: Record<number, string>;
  rpcMaps: RpcMapEntry[];
  rpcMapsByName: Record<string, RpcMapEntry>;
  sortedUidsByType: SortedUidTable;
  removedEntities: Record<number, number>;
  absentEntitiesFlags: number[];
  updatedEntityFlags: number[];

  constructor() {
    this.attributeMaps = {};
    this.entityTypeNames = {};
    this.rpcMaps = [];
    this.rpcMapsByName = {};
    this.sortedUidsByType = {};
    this.removedEntities = {};
    this.absentEntitiesFlags = [];
    this.updatedEntityFlags = [];
  }

  encode(name: PacketIds, item: EncodablePacket = {} as EncodablePacket): ArrayBuffer {
    const buffer = new ByteBuffer(100, true);

    switch (name) {
      case PacketIds.PACKET_ENTER_WORLD:
        buffer.writeUint8(PacketIds.PACKET_ENTER_WORLD);
        this.encodeEnterWorld(buffer, item as EnterWorldRequest);
        break;
      case PacketIds.PACKET_ENTER_WORLD2:
      case PacketIds.PACKET_BLEND:
        throw new DandelionError("PACKET_CODEC_ERROR", "Unsupported packet: " + name);
      case PacketIds.PACKET_INPUT:
        buffer.writeUint8(PacketIds.PACKET_INPUT);
        this.encodeInput(buffer, item as InputPacketData);
        break;
      case PacketIds.PACKET_PING:
        buffer.writeUint8(PacketIds.PACKET_PING);
        this.encodePing(buffer);
        break;
      case PacketIds.PACKET_RPC:
        buffer.writeUint8(PacketIds.PACKET_RPC);
        this.encodeRpc(buffer, item as ClientRpcData);
        break;
    }

    buffer.flip();
    buffer.compact();
    return buffer.toArrayBuffer(false);
  }

  decode(data: ArrayBuffer | Uint8Array): DecodedPacket {
    const buffer = ByteBuffer.wrap(data);
    buffer.littleEndian = true;

    const opcode = buffer.readUint8() as PacketIds;
    let decoded: DecodedPacket;

    switch (opcode) {
      case PacketIds.PACKET_ENTER_WORLD:
        decoded = this.decodeEnterWorldResponse(buffer);
        break;
      case PacketIds.PACKET_ENTER_WORLD2:
      case PacketIds.PACKET_BLEND:
        throw new DandelionError("PACKET_CODEC_ERROR", "Unsupported packet: " + opcode);
      case PacketIds.PACKET_ENTITY_UPDATE:
        decoded = this.decodeEntityUpdate(buffer);
        break;
      case PacketIds.PACKET_PING:
        decoded = this.decodePing();
        break;
      case PacketIds.PACKET_RPC:
        decoded = this.decodeRpc(buffer);
        break;
      default:
        throw new DandelionError("PACKET_CODEC_ERROR", "Unsupported packet: " + opcode);
    }

    decoded.opcode = opcode as never;
    return decoded;
  }

  decodeEnterWorldResponse(buffer: ByteBuffer): EnterWorldData {
    const result: EnterWorldData = {
      allowed: buffer.readUint32(),
      uid: buffer.readUint32(),
      startingTick: buffer.readUint32(),
      tickRate: buffer.readUint32(),
      effectiveTickRate: buffer.readUint32(),
      players: buffer.readUint32(),
      maxPlayers: buffer.readUint32(),
      chatChannel: buffer.readUint32(),
      effectiveDisplayName: safeReadVString(buffer),
      x1: buffer.readInt32(),
      y1: buffer.readInt32(),
      x2: buffer.readInt32(),
      y2: buffer.readInt32(),
    };

    const attributeMapCount = buffer.readUint32();
    this.attributeMaps = {};
    this.entityTypeNames = {};

    for (let i = 0; i < attributeMapCount; i++) {
      const attributeMap: AttributeMapEntry[] = [];
      const entityType = buffer.readUint32();
      const entityTypeString = buffer.readVString();
      const attributeCount = buffer.readUint32();

      for (let j = 0; j < attributeCount; j++) {
        attributeMap.push({
          name: buffer.readVString(),
          type: buffer.readUint32() as AttributeType,
        });
      }

      this.attributeMaps[entityType] = attributeMap;
      this.entityTypeNames[entityType] = entityTypeString;
      this.sortedUidsByType[entityType] = new Uint32Array(0);
    }

    const rpcCount = buffer.readUint32();
    this.rpcMaps = [];
    this.rpcMapsByName = {};

    for (let i = 0; i < rpcCount; i++) {
      const rpcName = buffer.readVString();
      const paramCount = buffer.readUint8();
      const isArray = buffer.readUint8() !== 0;
      const parameters: RpcParameterEntry[] = [];

      for (let j = 0; j < paramCount; j++) {
        parameters.push({
          name: buffer.readVString(),
          type: buffer.readUint8() as ParameterType,
        });
      }

      const rpc: RpcMapEntry = {
        name: rpcName,
        parameters,
        isArray,
        index: this.rpcMaps.length,
      };
      this.rpcMaps.push(rpc);
      this.rpcMapsByName[rpcName] = rpc;
    }

    return result;
  }

  decodeEntityUpdate(buffer: ByteBuffer): EntityUpdateData {
    const entityUpdateData: EntityUpdateData = {
      tick: buffer.readUint32(),
      entities: new Map(),
      byteSize: 0,
    };

    const removedEntityCount = readVarint32(buffer).value;
    this.removedEntities = {};

    for (let i = 0; i < removedEntityCount; i++) {
      this.removedEntities[buffer.readUint32()] = 1;
    }

    const brandNewEntityTypeCount = readVarint32(buffer).value;
    const newUidsByType = new Map<number, Uint32Array>();
    for (let i = 0; i < brandNewEntityTypeCount; i++) {
      const brandNewEntityCountForThisType = readVarint32(buffer).value;
      const brandNewEntityType = buffer.readUint32();
      const sortedUids = this.sortedUidsByType[brandNewEntityType];
      if (!sortedUids)
        throw new DandelionError("PACKET_CODEC_ERROR", "Entity type is not in UID table: " + brandNewEntityType);

      if (brandNewEntityCountForThisType === 0) continue;

      const newUids = new Uint32Array(brandNewEntityCountForThisType);
      for (let j = 0; j < brandNewEntityCountForThisType; j++) {
        newUids[j] = buffer.readUint32();
      }

      const existingNewUids = newUidsByType.get(brandNewEntityType);
      newUidsByType.set(
        brandNewEntityType,
        existingNewUids ? concatUidArrays(existingNewUids, newUids) : newUids,
      );
    }

    applyUidTableChanges(
      this.sortedUidsByType,
      this.removedEntities,
      removedEntityCount,
      newUidsByType,
    );

    while (buffer.remaining()) {
      const entityType = buffer.readUint32();
      const sortedUids = this.sortedUidsByType[entityType];
      const attributeMap = this.attributeMaps[entityType];

      if (!sortedUids || !attributeMap) {
        throw new DandelionError("PACKET_CODEC_ERROR", "Entity type is not in attribute map: " + entityType);
      }

      const absentEntitiesFlagsLength = Math.floor((sortedUids.length + 7) / 8);
      this.absentEntitiesFlags.length = 0;
      for (let i = 0; i < absentEntitiesFlagsLength; i++) {
        this.absentEntitiesFlags.push(buffer.readUint8());
      }

      for (let tableIndex = 0; tableIndex < sortedUids.length; tableIndex++) {
        const uid = sortedUids[tableIndex]!;
        const absentFlag = this.absentEntitiesFlags[Math.floor(tableIndex / 8)] ?? 0;

        if ((absentFlag & (1 << (tableIndex % 8))) !== 0) {
          entityUpdateData.entities.set(uid, true);
          continue;
        }

        const entity: EntityData = { uid };
        this.updatedEntityFlags.length = 0;
        for (let j = 0; j < Math.ceil(attributeMap.length / 8); j++) {
          this.updatedEntityFlags.push(buffer.readUint8());
        }

        for (let j = 0; j < attributeMap.length; j++) {
          const attribute = attributeMap[j]!;
          const flagIndex = Math.floor(j / 8);
          const bitIndex = j % 8;
          const updatedFlag = this.updatedEntityFlags[flagIndex] ?? 0;

          if (updatedFlag & (1 << bitIndex)) {
            entity[attribute.name] = this.decodeAttributeValue(buffer, attribute);
          }
        }

        entityUpdateData.entities.set(entity.uid, entity);
      }
    }

    entityUpdateData.byteSize = buffer.capacity();
    return entityUpdateData;
  }

  decodePing(): PingData {
    return {};
  }

  encodeRpc(buffer: ByteBuffer, item: ClientRpcData): void {
    const rpc = this.rpcMapsByName[item.name];
    if (!rpc) throw new DandelionError("PACKET_CODEC_ERROR", "RPC not in map: " + item.name);

    buffer.writeUint32(rpc.index);
    for (const parameter of rpc.parameters) {
      const param = item[parameter.name];

      switch (parameter.type) {
        case ParameterType.Float:
          buffer.writeInt32(Math.floor(Number(param) * 100));
          break;
        case ParameterType.Int32:
          buffer.writeInt32(Number(param));
          break;
        case ParameterType.String:
          buffer.writeVString(String(param));
          break;
        case ParameterType.Uint32:
          buffer.writeUint32(Number(param));
          break;
      }
    }
  }

  decodeRpcObject(buffer: ByteBuffer, parameters: RpcParameterEntry[]): RpcObject {
    const result: RpcObject = {};

    for (const parameter of parameters) {
      switch (parameter.type) {
        case ParameterType.Uint32:
          result[parameter.name] = buffer.readUint32();
          break;
        case ParameterType.Int32:
          result[parameter.name] = buffer.readInt32();
          break;
        case ParameterType.Float:
          result[parameter.name] = buffer.readInt32() / 100;
          break;
        case ParameterType.String:
          result[parameter.name] = safeReadVString(buffer);
          break;
        case ParameterType.Uint64:
          result[parameter.name] = readUint64(buffer);
          break;
        case ParameterType.Int64:
          result[parameter.name] = readInt64(buffer);
          break;
      }
    }

    return result;
  }

  decodeRpc(buffer: ByteBuffer): RpcData {
    const rpcIndex = buffer.readUint32();
    const rpc = this.rpcMaps[rpcIndex];
    if (!rpc) throw new DandelionError("PACKET_CODEC_ERROR", "RPC index is not in map: " + rpcIndex);

    if (rpc.isArray) {
      const response: RpcObject[] = [];
      const count = buffer.readUint16();
      for (let i = 0; i < count; i++) {
        response.push(this.decodeRpcObject(buffer, rpc.parameters));
      }

      return {
        name: rpc.name,
        response,
      };
    }

    return {
      name: rpc.name,
      response: this.decodeRpcObject(buffer, rpc.parameters),
    };
  }

  encodeEnterWorld(buffer: ByteBuffer, item: EnterWorldRequest): void {
    buffer.writeVString(item.displayName);

    const extra = new Uint8Array(item.extra);
    for (let i = 0; i < item.extra.byteLength; i++) {
      buffer.writeUint8(extra[i] ?? 0);
    }

    if (item.password !== undefined) {
      buffer.writeVString(item.password);
    }
  }

  encodeInput(buffer: ByteBuffer, item: InputPacketData): void {
    buffer.writeVString(JSON.stringify(item));
  }

  encodePing(buffer: ByteBuffer): void {
    buffer.writeUint8(0);
  }

  private decodeAttributeValue(
    buffer: ByteBuffer,
    attribute: AttributeMapEntry,
  ): EntityAttributeValue {
    switch (attribute.type) {
      case AttributeType.Uint32:
      case AttributeType.EntityType:
        return buffer.readUint32();
      case AttributeType.Int32:
        return buffer.readInt32();
      case AttributeType.Float:
        return buffer.readInt32() / 100;
      case AttributeType.String:
        return safeReadVString(buffer);
      case AttributeType.Vector2:
        return readVector2(buffer);
      case AttributeType.ArrayVector2: {
        const count = buffer.readInt32();
        const vectors: Vector2[] = [];
        for (let i = 0; i < count; i++) {
          vectors.push(readVector2(buffer));
        }
        return vectors;
      }
      case AttributeType.ArrayUint32: {
        const count = buffer.readInt32();
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
          values.push(buffer.readInt32());
        }
        return values;
      }
      case AttributeType.Uint16:
        return buffer.readUint16();
      case AttributeType.Uint8:
        return buffer.readUint8();
      case AttributeType.Int16:
        return buffer.readInt16();
      case AttributeType.Int8:
        return buffer.readInt8();
      case AttributeType.Uint64:
        return readUint64(buffer);
      case AttributeType.Int64:
        return readInt64(buffer);
      case AttributeType.Double:
        return readInt64(buffer) / 100;
      default:
        throw new DandelionError("PACKET_CODEC_ERROR", "Unsupported attribute type: " + attribute.type);
    }
  }

}

function applyUidTableChanges(
  sortedUidsByType: SortedUidTable,
  removedEntities: Record<number, number>,
  removedEntityCount: number,
  newUidsByType: Map<number, Uint32Array>,
): void {
  if (removedEntityCount === 0 && newUidsByType.size === 0) return;

  if (removedEntityCount > 0) {
    for (const entityType in sortedUidsByType) {
      const currentUids = sortedUidsByType[entityType] ?? new Uint32Array(0);
      const filteredUids = filterRemovedUids(currentUids, removedEntities);
      const newUids = newUidsByType.get(Number(entityType));

      if (!newUids) {
        sortedUidsByType[entityType] = filteredUids;
        continue;
      }

      const updatedUids = concatUidArrays(filteredUids, newUids);
      updatedUids.sort();
      sortedUidsByType[entityType] = updatedUids;
    }
    return;
  }

  for (const [entityType, newUids] of newUidsByType) {
    const currentUids = sortedUidsByType[entityType] ?? new Uint32Array(0);
    const updatedUids = concatUidArrays(currentUids, newUids);
    updatedUids.sort();
    sortedUidsByType[entityType] = updatedUids;
  }
}

function filterRemovedUids(
  sortedUids: Uint32Array,
  removedEntities: Record<number, number>,
): Uint32Array {
  let keptCount = 0;
  for (let i = 0; i < sortedUids.length; i++) {
    if (!hasRemovedUid(removedEntities, sortedUids[i]!)) keptCount++;
  }

  if (keptCount === sortedUids.length) return sortedUids;

  const filteredUids = new Uint32Array(keptCount);
  let index = 0;
  for (let i = 0; i < sortedUids.length; i++) {
    const uid = sortedUids[i]!;
    if (!hasRemovedUid(removedEntities, uid)) {
      filteredUids[index++] = uid;
    }
  }

  return filteredUids;
}

function concatUidArrays(
  first: Uint32Array,
  second: Uint32Array,
): Uint32Array {
  const result = new Uint32Array(first.length + second.length);
  result.set(first);
  result.set(second, first.length);
  return result;
}

function hasRemovedUid(
  removedEntities: Record<number, number>,
  uid: number,
): boolean {
  return Object.prototype.hasOwnProperty.call(removedEntities, uid);
}

export default MiniCodec;
