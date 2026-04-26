import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, "..");
const vendorDir = join(pluginDir, "vendor");
const sdkDir = join(vendorDir, "scs-sdk");
const zipPath = join(vendorDir, "scs_sdk_1_14.zip");
const sdkUrl = "https://download.eurotrucksimulator2.com/scs_sdk_1_14.zip";

if (existsSync(join(sdkDir, "include", "scssdk.h"))) {
    console.log(`SCS SDK already present: ${sdkDir}`);
    process.exit(0);
}

mkdirSync(vendorDir, { recursive: true });
rmSync(sdkDir, { recursive: true, force: true });

await download(sdkUrl, zipPath);

const extractDir = join(vendorDir, "scs-sdk-tmp");
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
execFileSync("unzip", ["-q", zipPath, "-d", extractDir], {
    stdio: "inherit",
});

rmSync(sdkDir, { recursive: true, force: true });
execFileSync("mv", [extractDir, sdkDir], { stdio: "inherit" });
console.log(`SCS SDK installed: ${sdkDir}`);

function download(url, destination) {
    return new Promise((resolve, reject) => {
        const request = get(url, (response) => {
            if (
                response.statusCode &&
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
            ) {
                response.resume();
                download(response.headers.location, destination)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(
                    new Error(
                        `Failed to download ${url}: HTTP ${response.statusCode}`,
                    ),
                );
                response.resume();
                return;
            }

            const file = createWriteStream(destination);
            response.pipe(file);
            file.on("finish", () => {
                file.close(resolve);
            });
            file.on("error", reject);
        });

        request.on("error", reject);
    });
}
