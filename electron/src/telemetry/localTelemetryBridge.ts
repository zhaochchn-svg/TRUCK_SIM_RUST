import dgram from "dgram";
import { WebSocketServer, WebSocket } from "ws";

type BridgeStatus = "stopped" | "starting" | "running";

export interface LocalTelemetryBridgeOptions {
    udpHost?: string;
    udpPort?: number;
    wsHost?: string;
    wsPort?: number;
    logPrefix?: string;
}

export class LocalTelemetryBridge {
    private udpSocket: dgram.Socket | null = null;
    private wsServer: WebSocketServer | null = null;
    private lastPacket: string | null = null;
    private status: BridgeStatus = "stopped";
    private readonly udpHost: string;
    private readonly udpPort: number;
    private readonly wsHost: string;
    private readonly wsPort: number;
    private readonly logPrefix: string;

    constructor(options: LocalTelemetryBridgeOptions = {}) {
        this.udpHost = options.udpHost ?? "127.0.0.1";
        this.udpPort = options.udpPort ?? 30002;
        this.wsHost = options.wsHost ?? "0.0.0.0";
        this.wsPort = options.wsPort ?? 30001;
        this.logPrefix = options.logPrefix ?? "[TelemetryBridge]";
    }

    async start(): Promise<void> {
        if (this.status === "running" || this.status === "starting") return;

        this.status = "starting";
        await Promise.all([this.startUdpListener(), this.startWsServer()]);
        this.status = "running";
        console.log(
            `${this.logPrefix} UDP ${this.udpHost}:${this.udpPort} -> WS ${this.wsHost}:${this.wsPort}`,
        );
    }

    stop(): void {
        this.status = "stopped";
        this.lastPacket = null;

        if (this.udpSocket) {
            this.udpSocket.close();
            this.udpSocket = null;
        }

        if (this.wsServer) {
            for (const client of this.wsServer.clients) {
                client.close();
            }
            this.wsServer.close();
            this.wsServer = null;
        }
    }

    isRunning(): boolean {
        return this.status === "running";
    }

    private startUdpListener(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket("udp4");

            socket.on("message", (message) => {
                const packet = message.toString("utf8");
                if (!this.isJson(packet)) return;

                this.lastPacket = packet;
                this.broadcast(packet);
            });

            socket.once("error", (error) => {
                console.error(`${this.logPrefix} UDP error`, error);
                reject(error);
            });

            socket.bind(this.udpPort, this.udpHost, () => {
                socket.removeAllListeners("error");
                socket.on("error", (error) =>
                    console.error(`${this.logPrefix} UDP error`, error),
                );
                this.udpSocket = socket;
                resolve();
            });
        });
    }

    private startWsServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = new WebSocketServer({
                host: this.wsHost,
                port: this.wsPort,
            });

            server.once("error", (error) => {
                console.error(`${this.logPrefix} WS error`, error);
                reject(error);
            });

            server.once("listening", () => {
                server.removeAllListeners("error");
                server.on("error", (error) =>
                    console.error(`${this.logPrefix} WS error`, error),
                );
                this.wsServer = server;
                resolve();
            });

            server.on("connection", (socket) => {
                if (this.lastPacket) {
                    socket.send(this.lastPacket);
                }
            });
        });
    }

    private broadcast(packet: string): void {
        if (!this.wsServer) return;

        for (const client of this.wsServer.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(packet);
            }
        }
    }

    private isJson(packet: string): boolean {
        try {
            JSON.parse(packet);
            return true;
        } catch {
            return false;
        }
    }
}
