export const usePlatform = () => {
    const isElectron = ref(false);
    const isMobile = ref(false);
    const isWeb = ref(false);

    if (typeof window !== "undefined") {
        const userAgent = window.navigator.userAgent.toLowerCase();
        const electronAPI = (window as any).electronAPI;
        const platform = electronAPI
            ? "electron"
            : /android/.test(userAgent)
              ? "android"
              : /iphone|ipad|ipod/.test(userAgent)
                ? "ios"
                : "web";

        if (platform === "web") isWeb.value = true;
        if (platform === "electron") isElectron.value = true;
        if (platform === "android" || platform === "ios") isMobile.value = true;
    }

    return {
        isElectron,
        isMobile,
        isWeb,
    };
};
