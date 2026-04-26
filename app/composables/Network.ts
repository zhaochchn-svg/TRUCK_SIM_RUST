export const useNetwork = () => {
    const localIP = ref<string>("");
    const localPort = ref<number>(3000);

    const fetchIp = async () => {
        if ((window as any).electronAPI) {
            localIP.value = await (window as any).electronAPI.getLocalIP();
        } else {
            localIP.value = window.location.hostname || "127.0.0.1";
        }
    };

    const fetchPort = async () => {
        if ((window as any).electronAPI) {
            localPort.value = await (window as any).electronAPI.getLocalPort();
        } else {
            localPort.value = Number(window.location.port) || 3000;
        }
    };

    return {
        localIP,
        localPort,
        fetchIp,
        fetchPort,
    };
};
