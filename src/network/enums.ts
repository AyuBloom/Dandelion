export enum PacketIds {
  PACKET_ENTITY_UPDATE = 0,
  PACKET_PLAYER_COUNTER_UPDATE = 1,
  PACKET_SET_WORLD_DIMENSIONS = 2,
  PACKET_INPUT = 3,
  PACKET_ENTER_WORLD = 4,
  PACKET_PRE_ENTER_WORLD = 5,
  PACKET_ENTER_WORLD2 = 6,
  PACKET_PING = 7,
  PACKET_RPC = 9,
  PACKET_BLEND = 10,
}

export enum AttributeType {
  Uninitialized = 0,
  Uint32 = 1,
  Int32 = 2,
  Float = 3,
  String = 4,
  Vector2 = 5,
  EntityType = 6,
  ArrayVector2 = 7,
  ArrayUint32 = 8,
  Uint16 = 9,
  Uint8 = 10,
  Int16 = 11,
  Int8 = 12,
  Uint64 = 13,
  Int64 = 14,
  Double = 15,
}

export enum ParameterType {
  Uint32 = 0,
  Int32 = 1,
  Float = 2,
  String = 3,
  Uint64 = 4,
  Int64 = 5,
}
