import dgram from "node:dgram";
import { EventEmitter } from "node:events";

import crc32 from "buffer-crc32";

enum PacketType {
  LOGIN = 0,
  COMMAND = 1,
  MESSAGE = 2,
}

interface RconClientConfig {
  ip: string;
  port: number;
  password: string;
  keepAliveInterval?: number;
}

enum Event {
  LOGIN = "login",
  MESSAGE = "message",
  DISCONNECT = "disconnect",
}

export class RconClient {
  private readonly socket: dgram.Socket;
  private readonly events: EventEmitter;

  private sequence: number = 0;
  private callbacks: Array<(message: string) => void> = [];
  private multipartPacket: Array<Buffer> = [];

  private isConnected: boolean = false;
  private isLoginProcessing: boolean = false;
  private loginCallback?: (success: boolean, error?: Error) => void;

  private readonly keepAliveInterval: number;
  private keepAliveIntervalInstance?: NodeJS.Timeout;
  private lastKeepaliveSequence: number = 0;

  public constructor(private readonly config: RconClientConfig) {
    this.socket = dgram.createSocket("udp4");
    this.events = new EventEmitter();

    this.keepAliveInterval = config.keepAliveInterval ?? 3000;

    this.socket.on(Event.MESSAGE, msg => this.packetReceived(msg));

    this.events.on(Event.DISCONNECT, () => {
      this.unsetKeepAlive();
      this.isConnected = false;
    });

    this.events.on(Event.LOGIN, (success: boolean, error?: Error) => {
      this.isLoginProcessing = false;
      this.isConnected = success;

      if (this.loginCallback) {
        this.loginCallback(success, error);
      }

      if (success) {
        this.setupKeepAlive();
      }
    });
  }

  public login(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (this.isLoginProcessing) {
        reject(new Error("Login in process already"));
        return;
      }

      if (this.isConnected) {
        reject(new Error("Connected already"));
        return;
      }

      this.isLoginProcessing = true;

      const packet = this.createLoginPacket(this.config.password);

      this.sendPacket(packet);

      setTimeout(() => {
        if (this.isLoginProcessing) {
          reject(new Error("Server didn't respond"));
          this.loginCallback = undefined;
          this.isLoginProcessing = false;
        }
      }, 5000);

      this.loginCallback = (success, error) =>
        error ? reject(error) : resolve(success);
    });
  }

  public sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error("Not connected"));
        return;
      }

      const packet = this.createCommandPacket(command);

      this.sendPacket(packet);

      this.callbacks[this.sequence - 1] = response => {
        resolve(response);
      };
    });
  }

  public onMessage(callback: (msg: string) => void): void {
    this.events.on(Event.MESSAGE, msg => callback(msg));
  }

  public onDisconnect(callback: () => void): void {
    this.events.on(Event.DISCONNECT, () => callback());
  }

  private setupKeepAlive(): void {
    this.keepAliveIntervalInstance = setInterval(() => {
      if (this.lastKeepaliveSequence) {
        this.events.emit(Event.DISCONNECT);
        return;
      }

      const packet = this.createKeepalivePacket();

      this.sendPacket(packet);
    }, this.keepAliveInterval);
  }

  private unsetKeepAlive(): void {
    clearInterval(this.keepAliveIntervalInstance);
  }

  private packetReceived(buffer: Buffer) {
    if (buffer.length < 9) {
      throw new Error("Packet must contain at least 9 bytes");
    }

    const beHeader = buffer.toString("utf8", 0, 2);

    if (beHeader !== "BE") {
      throw new Error("Invalid battle eye header");
    }

    const payload = buffer.subarray(6, buffer.length);
    const checksum = buffer.readInt32BE(2);
    const crc = crc32(payload).readInt32LE(0);

    if (checksum !== crc) {
      throw new Error("Checksum is incorrect");
    }

    switch (payload.readUInt8(1)) {
      case PacketType.LOGIN: {
        const isLoginSuccess = payload.readUInt8(2) == 1;

        this.events.emit(Event.LOGIN, isLoginSuccess);
        break;
      }
      case PacketType.COMMAND: {
        const sequence = payload.readUInt8(2);
        const message = payload.subarray(3, payload.length).toString();

        // keepalive response
        if (payload.length == 3) {
          if (
            payload.readUInt8(1) == 1 &&
            payload.readUInt8(2) == this.lastKeepaliveSequence
          ) {
            this.lastKeepaliveSequence = 0;
          }
        }

        const isMultipart = payload.length > 4 && payload.readUInt8(3) == 0;

        if (isMultipart) {
          const totalPackets = payload.readUInt8(4);
          const packetIndex = payload.readUInt8(5);
          const partPacket = payload.subarray(6, payload.length);
          const isAllPacketsReceived = packetIndex + 1 == totalPackets;

          if (this.multipartPacket[sequence] == null) {
            this.multipartPacket[sequence] = partPacket;
          } else {
            this.multipartPacket[sequence] = Buffer.concat(
              [this.multipartPacket[sequence], partPacket],
              this.multipartPacket[sequence].length + partPacket.length,
            );
          }

          if (isAllPacketsReceived) {
            if (typeof this.callbacks[sequence] == "function") {
              const callback = this.callbacks[sequence];

              callback(this.multipartPacket[sequence].toString());

              delete this.callbacks[sequence];
              delete this.multipartPacket[sequence];
            }
          }
          break;
        }

        if (typeof this.callbacks[sequence] == "function") {
          this.callbacks[sequence](message);
          delete this.callbacks[sequence];
        }

        break;
      }
      case PacketType.MESSAGE: {
        const sequence = payload.readUInt8(2);
        const packet = this.createAckPacket(sequence);
        const message = payload.subarray(3, payload.length).toString();

        this.sendPacket(packet);

        this.events.emit(Event.MESSAGE, message);
        break;
      }
    }
  }

  private sendPacket(payload: Buffer): void {
    this.socket.send(
      payload,
      0,
      payload.length,
      this.config.port,
      this.config.ip,
    );
  }

  private createAckPacket(sequence: number) {
    const data = Buffer.alloc(3);

    data.writeUInt8(0xff, 0);
    data.writeUInt8(PacketType.MESSAGE, 1);
    data.writeUInt8(sequence, 2);

    return this.createBEPacket(data);
  }

  private createLoginPacket(password: string) {
    const data = Buffer.alloc(password.length + 2);

    data.writeUInt8(0xff, 0);
    data.writeUInt8(PacketType.LOGIN, 1);

    data.write(password, 2);

    return this.createBEPacket(data);
  }

  private createKeepalivePacket = () => {
    const data = Buffer.alloc(3);

    data.writeUInt8(0xff, 0);
    data.writeUInt8(PacketType.COMMAND, 1);
    data.writeUInt8(this.sequence, 2);

    this.lastKeepaliveSequence = this.sequence;

    this.sequence = this.sequence >= 255 ? 0 : this.sequence + 1;

    return this.createBEPacket(data);
  };

  private createCommandPacket(command: string) {
    const data = Buffer.alloc(command.length + 3);

    data.writeUInt8(0xff, 0);
    data.writeUInt8(PacketType.COMMAND, 1);
    data.writeUInt8(this.sequence, 2);
    data.write(command, 3);

    this.sequence = this.sequence >= 255 ? 0 : this.sequence + 1;

    return this.createBEPacket(data);
  }

  private createBEPacket(payload: Buffer): Buffer {
    const header = Buffer.from([0x42, 0x45, 0x00, 0x00, 0x00, 0x00]);
    const crc = crc32(payload);

    header.writeInt32BE(crc.readInt32LE(0), 2);

    return Buffer.concat([header, payload], header.length + payload.length);
  }
}
