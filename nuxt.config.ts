import os from "node:os";

function getPreferredLanHost() {
    const addresses = Object.values(os.networkInterfaces())
        .flatMap((interfaces) => interfaces ?? [])
        .filter((iface) => iface.family === "IPv4" && !iface.internal)
        .map((iface) => iface.address);

    return (
        addresses.find((address) => address.startsWith("192.168.")) ??
        addresses.find((address) => address.startsWith("10.")) ??
        addresses.find((address) => address.startsWith("172.")) ??
        "0.0.0.0"
    );
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: "2025-07-15",
    devtools: { enabled: false },
    ssr: false,
    devServer: {
        host: getPreferredLanHost(),
        port: 3000,
    },
    modules: ["@nuxt/icon", "@nuxt/ui"],

	    css: ["~/assets/css/main.css", "~/assets/scss/global/_transitions.scss"],

    icon: {
        mode: "css",

        clientBundle: {
            scan: true,
            sizeLimitKb: 2048,
        },
    },

    vite: {
        css: {
            preprocessorOptions: {
                scss: {
                    additionalData: `@use "~/assets/scss/global/variables.scss" as *;
                     @use "~/assets/scss/global/_mixins.scss" as *;
                     @use "~/assets/scss/global/_fonts.scss" as *;`,
                },
            },
        },
    },

    app: {
        head: {
            title: "TruckNav",
            meta: [
                {
                    name: "viewport",
                    content:
                        "width=device-width, initial-scale=1, viewport-fit=cover",
                },
            ],
        },
    },

    components: [{ path: "~/components", pathPrefix: false }],
});
