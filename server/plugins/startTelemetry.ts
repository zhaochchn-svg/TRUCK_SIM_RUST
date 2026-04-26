import { defineNitroPlugin } from "#imports";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const EXE_NAME = "TruckNavTelemetry.exe";
const RUST_BIN_NAME = "trucknav-sim-rust";

export default defineNitroPlugin((nitroApp) => {
    const rootDir = process.cwd();

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
    }

    nitroApp.hooks.hook("close", killTelemetry);
});
