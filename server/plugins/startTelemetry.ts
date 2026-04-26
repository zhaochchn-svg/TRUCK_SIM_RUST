import { defineNitroPlugin } from "#imports";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const EXE_NAME = "TruckNavTelemetry.exe";
const RUST_BIN_NAME = "trucknav-sim-rust";

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return "127.0.0.1";
}

export default defineNitroPlugin((nitroApp) => {
    const rootDir = process.cwd();
    const localIP = getLocalIP();

    if (process.platform === "darwin") {
        console.log("[Telemetry] Starting Rust Backend on macOS...");
        
        const rustBinPath = path.join(rootDir, "backend", "target", "release", RUST_BIN_NAME);
        const dataDir = path.join(rootDir, "public", "data");

        if (existsSync(rustBinPath)) {
            const child = spawn(rustBinPath, ["--data-dir", dataDir], {
                detached: true,
                stdio: "inherit",
            });

            child.unref();

            // Print helpful URLs for other devices
            setTimeout(() => {
                console.log("\n" + "=".repeat(50));
                console.log("🚀 TruckNav is ready for other devices!");
                console.log(`📱 Web URL: http://${localIP}:3000`);
                console.log(`🔌 WebSocket: ws://${localIP}:30001`);
                console.log("=".repeat(50) + "\n");
            }, 2000);

            nitroApp.hooks.hook("close", () => {
                console.log("[Telemetry] Killing Rust backend...");
                child.kill();
            });
        } else {
            console.error(`[Telemetry] Rust binary not found at: ${rustBinPath}. Please run 'npm run rust:build' first.`);
        }
        return;
    }

    if (process.platform !== "win32") {
        console.warn(
            `[Telemetry] Native telemetry startup is not implemented for ${process.platform}.`,
        );
        return;
    }

    const serverExeDir = path.join(rootDir, "electron", "bin");
    const serverExePath = path.join(serverExeDir, EXE_NAME);

    const killTelemetry = () => {
        try {
            spawnSync("taskkill", ["/F", "/IM", EXE_NAME, "/T"], {
                stdio: "ignore",
                windowsHide: true,
            });
        } catch (e) {}
    };

    if (existsSync(serverExePath)) {
        const psCommand = `Start-Process -FilePath '${serverExePath}' -WorkingDirectory '${serverExeDir}' -WindowStyle Normal`;
        const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], {
            shell: true,
            detached: true,
            stdio: "ignore",
        });
        child.unref();
        
        console.log("\n" + "=".repeat(50));
        console.log("🚀 Windows Telemetry Plugin started.");
        console.log(`📱 Connect your devices to: http://${localIP}:3000`);
        console.log("=".repeat(50) + "\n");
    }

    nitroApp.hooks.hook("close", killTelemetry);
});
