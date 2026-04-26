import { app } from "electron";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
} from "fs";
import path from "path";
import { spawnSync } from "child_process";

export type GameKey = "ets2" | "ats";

interface MacGameInfo {
    key: GameKey;
    displayName: string;
    folderName: string;
    appName: string;
    binaryName: string;
}

interface PluginInstallResult {
    success: boolean;
    path?: string;
    message?: string;
}

const MAC_PLUGIN_NAME = "scs-trucknav.so";

const MAC_GAMES: MacGameInfo[] = [
    {
        key: "ets2",
        displayName: "ETS2",
        folderName: "Euro Truck Simulator 2",
        appName: "Euro Truck Simulator 2.app",
        binaryName: "eurotrucks2",
    },
    {
        key: "ats",
        displayName: "ATS",
        folderName: "American Truck Simulator",
        appName: "American Truck Simulator.app",
        binaryName: "amtrucks",
    },
];

export function checkMacPluginStatuses(): Record<GameKey, boolean> {
    const results: Record<GameKey, boolean> = { ets2: false, ats: false };
    const source = getMacPluginSourcePath();

    for (const game of MAC_GAMES) {
        const appPath = findInstalledMacGameApp(game);
        if (!appPath) continue;

        const pluginPath = getMacPluginDestination(appPath);
        if (existsSync(pluginPath)) {
            results[game.key] = true;
            continue;
        }

        if (existsSync(source)) {
            const install = installMacTelemetryPlugin(game.displayName, appPath);
            results[game.key] = install.success;
        }
    }

    return results;
}

export function installMacTelemetryPlugin(
    gameName: string,
    selectedPath?: string,
): PluginInstallResult {
    const game = getMacGameByName(gameName);
    if (!game) {
        return { success: false, message: `Unsupported game: ${gameName}` };
    }

    const appPath = selectedPath
        ? resolveMacGameAppPath(selectedPath, game)
        : findInstalledMacGameApp(game);

    if (!appPath) {
        return {
            success: false,
            message: `Could not find ${game.folderName}. Select the game's .app bundle or Steam common folder.`,
        };
    }

    const binaryPath = path.join(appPath, "Contents", "MacOS", game.binaryName);
    if (!existsSync(binaryPath)) {
        return {
            success: false,
            message: `Invalid ${game.displayName} app bundle: ${binaryPath} was not found.`,
        };
    }

    const source = getMacPluginSourcePath();
    if (!existsSync(source)) {
        return {
            success: false,
            message: `macOS telemetry plugin was not built. Expected: ${source}`,
        };
    }

    const destination = getMacPluginDestination(appPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, 0o755);
    clearQuarantine(destination);

    return { success: true, path: destination };
}

export function getMacPluginSourcePath(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, "bin", "darwin-x64", MAC_PLUGIN_NAME)
        : path.join(app.getAppPath(), "bin", "darwin-x64", MAC_PLUGIN_NAME);
}

function getMacPluginDestination(appPath: string): string {
    return path.join(appPath, "Contents", "MacOS", "plugins", MAC_PLUGIN_NAME);
}

function getMacGameByName(gameName: string): MacGameInfo | null {
    const normalized = gameName.toLowerCase();
    return (
        MAC_GAMES.find(
            (game) =>
                game.key === normalized ||
                game.displayName.toLowerCase() === normalized ||
                game.folderName.toLowerCase() === normalized,
        ) ?? null
    );
}

function findInstalledMacGameApp(game: MacGameInfo): string | null {
    for (const library of getMacSteamLibraries()) {
        const commonPath = getSteamCommonPath(library);
        const appPath = path.join(commonPath, game.folderName, game.appName);
        if (existsSync(appPath)) return appPath;
    }

    return null;
}

function resolveMacGameAppPath(
    selectedPath: string,
    game: MacGameInfo,
): string | null {
    const candidates = [
        selectedPath,
        path.join(selectedPath, game.appName),
        path.join(selectedPath, game.folderName, game.appName),
        path.join(path.dirname(selectedPath), game.appName),
    ];

    if (selectedPath.endsWith(path.join("Contents", "MacOS"))) {
        candidates.unshift(path.dirname(path.dirname(selectedPath)));
    }

    for (const candidate of candidates) {
        if (
            candidate.endsWith(".app") &&
            existsSync(path.join(candidate, "Contents", "MacOS", game.binaryName))
        ) {
            return candidate;
        }
    }

    return null;
}

function getMacSteamLibraries(): string[] {
    const steamRoot = path.join(
        app.getPath("home"),
        "Library",
        "Application Support",
        "Steam",
    );
    const libraries = new Set<string>([steamRoot]);
    const vdfPath = path.join(steamRoot, "steamapps", "libraryfolders.vdf");

    if (!existsSync(vdfPath)) return Array.from(libraries);

    try {
        const content = readFileSync(vdfPath, "utf8");
        const matches = content.match(/"path"\s+"([^"]+)"/g) ?? [];

        for (const item of matches) {
            const match = item.match(/"path"\s+"([^"]+)"/);
            if (match?.[1]) {
                libraries.add(match[1].replace(/\\\\/g, "\\"));
            }
        }
    } catch (error) {
        console.error("[Telemetry] Failed to read Steam libraries", error);
    }

    return Array.from(libraries);
}

function getSteamCommonPath(libraryPath: string): string {
    if (libraryPath.endsWith(path.join("steamapps", "common"))) {
        return libraryPath;
    }

    if (libraryPath.endsWith("steamapps")) {
        return path.join(libraryPath, "common");
    }

    return path.join(libraryPath, "steamapps", "common");
}

function clearQuarantine(filePath: string): void {
    spawnSync("xattr", ["-d", "com.apple.quarantine", filePath], {
        stdio: "ignore",
    });
}
