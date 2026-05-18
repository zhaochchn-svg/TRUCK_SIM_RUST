import { reactive, ref, toRefs } from "vue";
import {
    getGameState,
    getJobState,
    getNavigationState,
    getTruckState,
} from "~/assets/utils/telemetry/helpers";
import type {
    TruckState,
    GameState,
    NavigationState,
    JobState,
    TelemetryEventNotification,
    TelemetryUpdate,
    TelemetryPacket,
} from "~/types";

// 状态定义
const truckState = reactive<TruckState>({ truckCoords: [0, 0], truckHeading: 0, truckSpeed: 0, averageSpeed: 80 });
const gameState = reactive<GameState>({ gameTime: "", gameConnected: false, hasInGameMarker: false, scale: 0 });
const navigationState = reactive<NavigationState>({ fuel: 0, speedLimit: 0, restStoptime: "", restStopMinutes: 0 });
const jobState = reactive<JobState>({ hasActiveJob: false, income: 0, deadlineTime: new Date(), remainingTime: new Date(), sourceCity: "0", sourceCompany: "0", destinationCity: "0", destinationCompany: "0" });
const telemetryEventNotifications = ref<TelemetryEventNotification[]>([]);

let lastPosition: [number, number] | null = null;
let headingOffset = 0;
let socket: WebSocket | null = null;
let isConnecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shouldReconnect = false;
let telemetryEventCounter = 0;

const MAX_EVENT_NOTIFICATIONS = 8;
const EVENT_DEDUPE_WINDOW_MS = 15_000;
const eventSeenAt = new Map<string, number>();

type TelemetryEventDraft = Omit<TelemetryEventNotification, "id" | "createdAt">;

function formatCurrency(amount: number, game: string, signed = false) {
    const currency = game.toLowerCase() === "ets2" ? "€" : "$";
    const rounded = Math.round(Math.abs(amount));
    const prefix = signed ? (amount >= 0 ? "+" : "-") : "";
    return `${prefix}${currency}${rounded.toLocaleString()}`;
}

function formatRouteLabel(sourceName?: string, targetName?: string) {
    const source = sourceName?.trim();
    const target = targetName?.trim();
    if (source && target) return `${source} → ${target}`;
    if (source) return source;
    if (target) return target;
    return "";
}

function addTelemetryEventNotification(notification: TelemetryEventDraft) {
    const now = Date.now();
    const lastSeen = eventSeenAt.get(notification.key) ?? 0;
    if (now - lastSeen < EVENT_DEDUPE_WINDOW_MS) return;

    eventSeenAt.set(notification.key, now);
    telemetryEventNotifications.value = [
        {
            ...notification,
            id: `${now}-${telemetryEventCounter++}`,
            createdAt: now,
        },
        ...telemetryEventNotifications.value,
    ].slice(0, MAX_EVENT_NOTIFICATIONS);
}

function getEventKey(
    data: TelemetryPacket,
    eventType: string,
    fallbackParts: Array<string | number | boolean | undefined>,
) {
    const serial = data.gamePlayEvents?.eventSerial ?? 0;
    if (Number.isFinite(serial) && serial > 0) {
        return `${serial}:${eventType}`;
    }

    return `${eventType}:${fallbackParts.map((part) => String(part ?? "")).join("|")}`;
}

function processGameplayEvents(data: TelemetryPacket) {
    const special = data.specialEvents;
    const events = data.gamePlayEvents;
    if (!special || !events) return;

    const fine = events.finedData;
    if (special.fined || fine.payAmount > 0 || fine.offence) {
        addTelemetryEventNotification({
            key: getEventKey(data, "fined", [fine.payAmount, fine.offence]),
            category: "finance",
            title: "罚款",
            detail: `${fine.offence || "违规"}${fine.payAmount > 0 ? ` · -${formatCurrency(fine.payAmount, data.game)}` : ""}`,
            icon: "lucide:badge-alert",
        });
    }

    if (special.tollgate || events.tollgatePayment > 0) {
        addTelemetryEventNotification({
            key: getEventKey(data, "tollgate", [events.tollgatePayment]),
            category: "finance",
            title: "收费站",
            detail:
                events.tollgatePayment > 0
                    ? `已支付 ${formatCurrency(events.tollgatePayment, data.game)}`
                    : "已通过收费站",
            icon: "lucide:receipt-text",
        });
    }

    if (special.jobCancelled || events.jobCancelledPenalty > 0) {
        addTelemetryEventNotification({
            key: getEventKey(data, "job-cancelled", [
                events.jobCancelledPenalty,
            ]),
            category: "finance",
            title: "任务取消",
            detail:
                events.jobCancelledPenalty > 0
                    ? `罚金 -${formatCurrency(events.jobCancelledPenalty, data.game)}`
                    : "物流任务已取消",
            icon: "lucide:circle-x",
        });
    }

    const delivered = events.jobDelivered;
    if (
        special.jobDelivered ||
        delivered.revenue > 0 ||
        delivered.earnedXp > 0 ||
        delivered.distanceKm > 0
    ) {
        const parts = [
            delivered.revenue > 0
                ? `收入 ${formatCurrency(delivered.revenue, data.game, true)}`
                : "",
            delivered.earnedXp > 0 ? `XP +${delivered.earnedXp}` : "",
            delivered.distanceKm > 0 ? `${Math.round(delivered.distanceKm)} km` : "",
            delivered.cargoDamage > 0
                ? `货损 ${Math.round(delivered.cargoDamage * 100)}%`
                : "",
        ].filter(Boolean);

        addTelemetryEventNotification({
            key: getEventKey(data, "job-delivered", [
                delivered.revenue,
                delivered.earnedXp,
                delivered.distanceKm,
                delivered.cargoDamage,
            ]),
            category: "logistics",
            title: "送货完成",
            detail: parts.join(" · ") || "物流任务已完成",
            icon: "lucide:package-check",
        });
    }

    const ferryRoute = formatRouteLabel(
        events.ferryData.sourceName,
        events.ferryData.targetName,
    );
    if (special.ferry || ferryRoute || events.ferryData.payAmount > 0) {
        addTelemetryEventNotification({
            key: getEventKey(data, "ferry", [
                events.ferryData.payAmount,
                events.ferryData.sourceName,
                events.ferryData.targetName,
            ]),
            category: "logistics",
            title: "渡轮",
            detail: [
                ferryRoute || "使用渡轮",
                events.ferryData.payAmount > 0
                    ? `-${formatCurrency(events.ferryData.payAmount, data.game)}`
                    : "",
            ]
                .filter(Boolean)
                .join(" · "),
            icon: "lucide:ship",
        });
    }

    const trainRoute = formatRouteLabel(
        events.trainData.sourceName,
        events.trainData.targetName,
    );
    if (special.train || trainRoute || events.trainData.payAmount > 0) {
        addTelemetryEventNotification({
            key: getEventKey(data, "train", [
                events.trainData.payAmount,
                events.trainData.sourceName,
                events.trainData.targetName,
            ]),
            category: "logistics",
            title: "火车转运",
            detail: [
                trainRoute || "使用火车转运",
                events.trainData.payAmount > 0
                    ? `-${formatCurrency(events.trainData.payAmount, data.game)}`
                    : "",
            ]
                .filter(Boolean)
                .join(" · "),
            icon: "lucide:train-front",
        });
    }
}

/**
 * 纯 Web 版遥感数据处理
 */
export function useEtsTelemetry() {
    const { settings } = useSettings();
    let speedSamples: number[] = [];
    const maxSamples = 120;

    function startTelemetry(onUpdate?: (data: TelemetryUpdate) => void) {
        if (socket || isConnecting) return;
        shouldReconnect = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        isConnecting = true;

        // 统一使用当前网页的域名/IP 连接
        const url = `ws://${window.location.hostname}:30001`;

        try {
            socket = new WebSocket(url);
            socket.onopen = () => { console.log("[RustBridge] WebSocket 已连接"); isConnecting = false; };
            socket.onmessage = (event) => {
                try {
                    const response = JSON.parse(event.data);
                    if (response.type === "TELEMETRY") {
                        const data = response.payload as TelemetryPacket;
                        if (data.game.toLowerCase() === settings.value.selectedGame) processData(data, onUpdate);
                    } else if (response.type === "ROUTE_RESULT") {
                        window.dispatchEvent(new CustomEvent("route-result", { detail: response.payload }));
                    }
                } catch (e) { console.error("解析错误", e); }
            };
            socket.onclose = () => {
                socket = null; isConnecting = false;
                resetDataOnDisconnected(onUpdate);
                if (shouldReconnect) {
                    reconnectTimer = setTimeout(() => startTelemetry(onUpdate), 3000);
                }
            };
            socket.onerror = () => { isConnecting = false; };
        } catch (e) { isConnecting = false; }
    }

    function stopTelemetry() {
        shouldReconnect = false;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (socket) {
            socket.close();
            socket = null;
        }
        isConnecting = false;
    }
    function sendWsMessage(message: any) { if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(message)); return true; } return false; }

    function processData(data: TelemetryPacket, onUpdate?: (data: TelemetryUpdate) => void) {
        const { gameConnected, hasInGameMarker, gameTime, scale } = getGameState(data);
        Object.assign(gameState, { gameTime, gameConnected, hasInGameMarker, scale });
        const { truckCoords, truckSpeed, truckHeading, headingOffset: newOffset, avgSpeed } = getTruckState(data, lastPosition, settings.value.selectedGame, headingOffset, speedSamples, maxSamples);
        Object.assign(truckState, { truckCoords, truckHeading, truckSpeed, averageSpeed: avgSpeed });
        lastPosition = truckCoords; headingOffset = newOffset;
        const { fuel, speedLimit, restStoptime, restStopMinutes } = getNavigationState(data);
        Object.assign(navigationState, { restStoptime, restStopMinutes, speedLimit, fuel });
        const { hasActiveJob, cityTarget: destinationCity, companyTarget: destinationCompany } = getJobState(data, settings.value.selectedGame);
        Object.assign(jobState, { hasActiveJob, destinationCity, destinationCompany });
        processGameplayEvents(data);
        if (onUpdate) onUpdate({ truck: { ...truckState }, game: { ...gameState }, general: { ...navigationState }, job: { ...jobState } });
    }

    function resetDataOnDisconnected(onUpdate?: (data: TelemetryUpdate) => void) {
        headingOffset = 0; lastPosition = null; speedSamples = [];
        Object.assign(gameState, { gameConnected: false, hasInGameMarker: false, gameTime: "", scale: 0 });
        Object.assign(truckState, { truckCoords: [0, 0], truckHeading: 0, truckSpeed: 0 });
        Object.assign(navigationState, { fuel: 0, speedLimit: 0, restStopMinutes: 0, restStoptime: "0" });
        Object.assign(jobState, { hasActiveJob: false });
        telemetryEventNotifications.value = [];
        eventSeenAt.clear();
        if (onUpdate) onUpdate({ truck: { ...truckState }, game: { ...gameState }, general: { ...navigationState }, job: { ...jobState } });
    }

    return { ...toRefs(navigationState), ...toRefs(truckState), ...toRefs(gameState), ...toRefs(jobState), telemetryEventNotifications, startTelemetry, stopTelemetry, sendWsMessage };
}
