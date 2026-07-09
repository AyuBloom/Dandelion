import MiniCodec from "../network/mini-codec.ts";
import { PacketIds } from "../network/enums.ts";
import { DandelionError, getErrorMessage } from "../shared/errors.ts";
import type { DurableConnectionId, SessionId } from "../shared/ids.ts";
import type { DurableConnectionStatus, IpcMessage } from "../shared/ipc.ts";
import { logger } from "../shared/logger.ts";
import type {
  EnterWorldData,
  EncodablePacket,
} from "../shared/packets.ts";
import { SolverWorker } from "./solver-worker.ts";

interface DurableConnectionOptions {
  sessionId: SessionId;
  durableConnectionId: DurableConnectionId;
  serverId: string;
  hostname: string;
  ipAddress: string;
  port?: number;
  displayName: string;
}

const fakeMetrics = {
  name: "Metrics",
  minFps: 21.74,
  maxFps: 70.2,
  currentFps: 60.34,
  averageFps: 59.7,
  framesRendered: 7442,
  framesInterpolated: 7442,
  framesExtrapolated: 0,
  allocatedNetworkEntities: 200,
  currentClientLag: 203,
  minClientLag: 99,
  maxClientLag: 398,
  currentPing: 101.5,
  minPing: 91,
  maxPing: 113,
  averagePing: 96.85,
  longFrames: 1,
  stutters: 142,
  group: 0,
  isMobile: 0,
  timeResets: 1,
  maxExtrapolationTime: 0,
  extrapolationIncidents: 0,
  totalExtrapolationTime: 0,
  differenceInClientTime: 16.7,
};

const parent = process as typeof process & {
  send?: (message: unknown) => void;
};

export class DurableConnection {
  private readonly codec = new MiniCodec();
  private readonly solver: SolverWorker;
  private socket?: WebSocket;
  private keepaliveTimer?: Timer;
  private status: DurableConnectionStatus = "booting";
  private lastPingAt = 0;
  private pingStart?: number;
  private ping?: number;
  private exiting = false;

  constructor(private readonly options: DurableConnectionOptions) {
    this.solver = new SolverWorker(options.ipAddress);
    this.solver.onUnexpectedExit((error) => this.fail(getErrorMessage(error)));
  }

  async start(): Promise<void> {
    process.on("message", this.onSessionIPC);
    this.publishStatus("booting");
    await this.solver.waitUntilReady();
    this.connect();
  }

  close(): void {
    process.off("message", this.onSessionIPC);
    this.stopKeepalive();
    this.publishStatus("closing");
    this.socket?.close();
    this.solver.close();

    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.exit(0);
    }
  }

  private readonly onSessionIPC = (message: IpcMessage): void => {
    this.handleSessionIPC(message);
  };

  private handleSessionIPC(message: IpcMessage): void {
    if (message.from !== "session" || this.status !== "in-world") return;

    try {
      switch (message.type) {
        case "session.input":
          this.sendPacket(PacketIds.PACKET_INPUT, message.payload);
          break;
        case "session.rpc":
          if (
            message.payload.byteLength <= 256 &&
            message.payload[0] === PacketIds.PACKET_RPC
          ) {
            this.send(message.payload);
          }
          break;
        default:
          break;
      }
    } catch (error) {
      logger.warn("Rejected invalid session packet", {
        error: getErrorMessage(error),
      });
    }
  }

  private connect(): void {
    this.publishStatus("connecting");

    const socket = new WebSocket(this.websocketUrl(), {
      headers: {
        Origin: "",
        "User-Agent": "",
      },
    });
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.publishStatus("waiting-pre-enter");
      this.sendPacket(PacketIds.PACKET_PING, {});
    };
    socket.onmessage = (event) => void this.handleMessageData(event.data);
    socket.onerror = () => this.fail("Connection error");
    socket.onclose = () => this.handleClose();
  }

  private async handleMessageData(data: ArrayBuffer): Promise<void> {
    try {
      const bytes = new Uint8Array(data);
      const opcode = bytes[0];
      switch (opcode) {
        case PacketIds.PACKET_PRE_ENTER_WORLD:
          await this.handlePreEnterWorld(bytes);
          return;
        case PacketIds.PACKET_ENTER_WORLD:
          await this.handleEnterWorld(data, bytes);
          return;
        case PacketIds.PACKET_PING:
          this.handlePing();
          return;
        case PacketIds.PACKET_BLEND:
          await this.handleBlend(bytes);
          return;
        // omitted entity update handler
      }
      this.publishDurablePacket(data);
    } catch (error) {
      // Server packets are isolated so a client-side decode failure cannot close the socket.
      logger.warn("Failed to process server packet", {
        error: getErrorMessage(error),
      });
    }
  }

  private async handlePreEnterWorld(bytes: Uint8Array): Promise<void> {
    if (this.status !== "waiting-pre-enter") return;

    const extra = await this.solver.solvePreEnter(bytes.subarray(1));
    this.sendPacket(PacketIds.PACKET_ENTER_WORLD, {
      displayName: this.options.displayName,
      extra,
    });
    this.publishStatus("waiting-enter-world");
  }

  private async handleEnterWorld(data: ArrayBuffer, bytes: Uint8Array): Promise<void> {
    if (this.status !== "waiting-enter-world") return;

    const packet = this.codec.decode(bytes) as EnterWorldData;
    if (!packet.allowed) {
      this.fail("Server is full");
      return;
    }

    this.publishDurablePacket(data);

    const extra = await this.solver.enterWorld2();
    this.sendRaw(PacketIds.PACKET_ENTER_WORLD2, extra);

    this.publishStatus("in-world");
    this.sendPing();
    this.startKeepalive();
  }

  private async handleBlend(bytes: Uint8Array): Promise<void> {
    if (
      this.status === "closing" ||
      this.status === "closed" ||
      this.status === "failed"
    ) {
      return;
    }

    const extra = await this.solver.solveBlend(bytes.subarray(1));
    this.sendRaw(PacketIds.PACKET_BLEND, new Uint8Array(extra));
  }

  private handlePing(): void {
    if (this.pingStart) {
      this.ping = Math.round((Date.now() - this.pingStart) / 2);
      this.pingStart = undefined;
    }

    this.publishStatus();
  }

  private startKeepalive(): void {
    this.stopKeepalive();

    this.keepaliveTimer = setInterval(() => {
      this.sendPingIfNeeded();
    }, 2500);
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private sendPingIfNeeded(): void {
    if (this.status !== "in-world") return;

    const now = Date.now();
    if (this.pingStart || now - this.lastPingAt < 5000) {
      return;
    }

    this.sendPing();
  }

  private sendPing(): void {
    const now = Date.now();
    this.pingStart = now;
    this.sendPacket(PacketIds.PACKET_PING, {});
    this.sendPacket(PacketIds.PACKET_RPC, fakeMetrics);
    this.lastPingAt = now;
  }

  private send(packet: ArrayBuffer | Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    this.socket.send(packet);
  }

  private sendRaw(opcode: PacketIds, payload: Uint8Array): void {
    const packet = new Uint8Array(1 + payload.byteLength);
    packet[0] = opcode;
    packet.set(payload, 1);
    this.send(packet.buffer);
  }

  private sendPacket(
    opcode: PacketIds,
    data: EncodablePacket,
  ): void {
    const packet = this.codec.encode(opcode, data);
    this.send(packet);
  }

  private websocketUrl(): string {
    const port = this.options.port ?? 443;
    return `wss://${this.options.hostname}:${port}`;
  }

  private handleClose(): void {
    this.stopKeepalive();
    this.solver.close();

    if (this.status !== "failed") {
      this.publishStatus("closed");
    }

    this.exit(this.status === "failed" ? 1 : 0);
  }

  private fail(error: string): void {
    if (this.status === "failed" || this.status === "closed") return;

    logger.error("Durable connection failed: ", error);
    this.stopKeepalive();
    this.publishStatus("failed", error);
    this.socket?.close();
    this.solver.close();
    this.exit(1);
  }

  private exit(code: number): void {
    if (this.exiting) return;
    this.exiting = true;

    setTimeout(() => process.exit(code), 0);
  }

  private publishStatus(status = this.status, error?: string): void {
    this.status = status;

    parent.send?.({
      type: "durable.status",
      from: "durable-connection",
      to: "session",
      payload: {
        sessionId: this.options.sessionId,
        durableConnectionId: this.options.durableConnectionId,
        serverId: this.options.serverId,
        hostname: this.options.hostname,
        ipAddress: this.options.ipAddress,

        status,
        ping: this.ping,

        error,
      },
    } satisfies IpcMessage);
  }

  private publishDurablePacket(data: ArrayBuffer): void {
    parent.send?.({
      type: "durable.packet",
      from: "durable-connection",
      to: "session",
      payload: {
        data,
        sessionId: this.options.sessionId,
      },
    } satisfies IpcMessage);
  }
}
