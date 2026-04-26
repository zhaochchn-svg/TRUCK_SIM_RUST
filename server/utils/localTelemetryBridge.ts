import dgram from "node:dgram";
import { WebSocket, WebSocketServer } from "ws";

export class LocalTelemetryBridge {
    private udpSocket: dgram.Socket | null = null;
    private wsServer: WebSocketServer | null = null;
    private lastPacket: string | null = null;
    private running = false;

    constructor(
        private readonly udpHost = "127.0.0.1",
        private readonly udpPort = 30002,
        private readonly wsHost = "0.0.0.0",
        private readonly wsPort = 30001,
    ) {}

    async start() {
        if (this.running) return;
        await Promise.all([this.startUdpListener(), this.startWsServer()]);
        this.running = true;
        console.log(
            `[TelemetryBridge] UDP ${this.udpHost}:${this.udpPort} -> WS ${this.wsHost}:${this.wsPort}`,
        );
    }

    stop() {
        this.running = false;
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

    private startUdpListener() {
        return new Promise<void>((resolve, reject) => {
            const socket = dgram.createSocket("udp4");

            socket.on("message", (message) => {
                const packet = message.toString("utf8");
                if (!this.isJson(packet)) return;

                this.lastPacket = packet;
                this.broadcast(packet);
            });

            socket.once("error", reject);
            socket.bind(this.udpPort, this.udpHost, () => {
                socket.removeAllListeners("error");
                socket.on("error", (error) =>
                    console.error("[TelemetryBridge] UDP error", error),
                );
                this.udpSocket = socket;
                resolve();
            });
        });
    }

    private startWsServer() {
        return new Promise<void>((resolve, reject) => {
            const server = new WebSocketServer({
                host: this.wsHost,
                port: this.wsPort,
            });

            server.once("error", reject);
            server.once("listening", () => {
                server.removeAllListeners("error");
                server.on("error", (error) =>
                    console.error("[TelemetryBridge] WS error", error),
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

    private broadcast(packet: string) {
        if (!this.wsServer) return;

        for (const client of this.wsServer.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(packet);
            }
        }
    }

    private isJson(packet: string) {
        try {
            JSON.parse(packet);
            return true;
        } catch {
            return false;
        }
    }
}
