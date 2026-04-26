import maplibregl from "maplibre-gl";
import { generateDestinationIcon } from "~/assets/utils/map/markers";
import {
    getSqDistToSegment,
    DEVIATION_THRESHOLD_SQ,
    getSquaredDist,
} from "~/assets/utils/map/maths";
import {
    deleteMapLibreData,
    setMapLibreData,
} from "~/assets/utils/map/helpers";
import {
    generateDirectionsList,
    type DirectionStep,
} from "~/assets/utils/routing/directions";

/**
 * 路由控制组合式函数
 * 处理高性能 Rust 路由交互、偏航检查以及多端引导同步
 */
export const useRouteController = (
    map: Ref<maplibregl.Map | null>,
    adjacency: Map<number, any>,
    nodeCoords: Map<number, [number, number]>,
    stopNavigationMode: () => void,
) => {
    const { getGameLocationName } = useCityData();
    const { getClosestNodes } = useGraphSystem();
    const { settings, activeSettings, updateProfile } = useSettings();
    const { processNavigationUpdate, resetVoiceState, announceStart, announceReroute } = useVoiceNavigation();
    const { sendWsMessage } = useEtsTelemetry();

    // 状态管理
    const currentRoutePath = shallowRef<[number, number][] | null>(null);
    const routeStatsCache = shallowRef<Float32Array | null>(null);
    const routePathProgressCache = shallowRef<Float64Array | null>(null);
    const destinationName = ref<string>("");
    const routeDistance = ref<number>(0);
    const routeEta = ref<string>("");
    const savedDestination = ref<[number, number] | null>(null);
    const isRouteActive = ref(false);
    const isYardStart = ref(false);
    const startNodeId = ref<number | null>(null);
    const endNodeId = ref<number | null>(null);
    const lastMathPos = ref<[number, number] | null>(null);
    const isCalculating = ref(false);
    const routeFound = ref<boolean | null>(null);
    const currentRouteIndex = ref(0);
    const isWorkerReady = ref(false);
    const fullRouteDirections = ref<DirectionStep[]>([]);
    const nextTurnDistance = ref<number>(0);

    const isHandlingDeviation = ref(false);
    let lastRerouteTime = 0;
    let routeCalculatedAt = 0;
    let offRouteUpdates = 0;
    const REROUTE_COOLDOWN = 15000;
    const REROUTE_GRACE_MS = 5000;
    const OFF_ROUTE_CONFIRMATION_UPDATES = 6;
    const ROUTE_DEVIATION_THRESHOLD_SQ = DEVIATION_THRESHOLD_SQ * 4;

    watch(() => activeSettings.value.themeColor, async (newColor) => {
        if (map.value && map.value.hasImage("destination-icon")) {
            const newPinImg = await generateDestinationIcon(newColor);
            map.value.updateImage("destination-icon", newPinImg);
        }
    });

    watch(() => activeSettings.value.routeColor, (newColor) => {
        if (map.value && map.value.getLayer("route-line")) {
            map.value.setPaintProperty("route-line", "line-color", newColor);
        }
    });

    function initWorkerData() { isWorkerReady.value = true; }
    function destroyWorker() { isWorkerReady.value = false; }

    function projectPointToSegment(p: [number, number], v: [number, number], w: [number, number]): [number, number] {
        const l2 = getSquaredDist(v, w);
        if (l2 === 0) return [v[0], v[1]];
        let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
        t = Math.max(0, Math.min(1, t));
        return [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])];
    }

    function appendUniquePoint(points: [number, number][], point: [number, number]) {
        const last = points[points.length - 1];
        if (!last || getSquaredDist(last, point) > 0.000000000001) {
            points.push(point);
        }
    }

    function getPlanarDistance(a: [number, number], b: [number, number]) {
        const dx = (b[0] - a[0]) * 0.65;
        const dy = b[1] - a[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    function buildPathProgressCache(points: [number, number][]) {
        const cache = new Float64Array(points.length);
        for (let i = 1; i < points.length; i++) {
            cache[i] =
                cache[i - 1]! + getPlanarDistance(points[i - 1]!, points[i]!);
        }
        return cache;
    }

    function getRouteTotalKm(cache: Float32Array) {
        return cache.length >= 2 ? cache[cache.length - 2] || 0 : 0;
    }

    function getEffectiveSpeedKph(avgSpeed: number) {
        return Number.isFinite(avgSpeed) && avgSpeed > 5 ? avgSpeed : 80;
    }

    function formatDuration(hours: number) {
        if (!Number.isFinite(hours) || hours <= 0.01) return "即将到达";
        const h = Math.floor(hours);
        const m = Math.max(1, Math.round((hours - h) * 60));
        return h > 0 ? `${h}小时 ${m}分钟` : `${m}分钟`;
    }

    function updateRouteSummary(traveledKm: number, avgSpeed: number) {
        const cache = routeStatsCache.value;
        if (!cache) return;

        const totalKm = getRouteTotalKm(cache);
        const safeTraveledKm = Math.min(Math.max(traveledKm, 0), totalKm);
        const remainingKm = Math.max(0, totalKm - safeTraveledKm);
        const speedKph = getEffectiveSpeedKph(avgSpeed);

        routeDistance.value = remainingKm;
        routeEta.value = formatDuration(remainingKm / speedKph);

        const nextStep = fullRouteDirections.value.find((step) => {
            if (step.type === "depart" || step.type === "destination") return false;
            return (step.cumulativeKm ?? Infinity) > safeTraveledKm + 0.03;
        });

        nextTurnDistance.value = nextStep?.cumulativeKm
            ? Math.max(0, nextStep.cumulativeKm - safeTraveledKm)
            : remainingKm;

        if (nextStep) {
            processNavigationUpdate(
                nextTurnDistance.value,
                nextStep.id,
                nextStep.text,
                nextStep.type === "destination",
            );
        }
    }

    /**
     * 初始化地图图层 (修复: 重新补全缺失的函数定义)
     */
    async function setupRouteLayer() {
        if (!map.value) return;
        // 如果图层已存在，则不重复创建
        if (map.value.getSource("route-line")) return;

        if (!map.value.hasImage("destination-icon")) {
            const pinImg = await generateDestinationIcon();
            map.value.addImage("destination-icon", pinImg, { pixelRatio: 2.5 });
        }

        // 导航路径数据源
        map.value.addSource("route-line", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
        });

        const beforeId = map.value.getLayer("all-sprites") ? "all-sprites" : undefined;

        // 绘制多层路径以实现发光/发光描边效果
        map.value.addLayer({
            id: "route-line-rail", type: "line", source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#475569", "line-opacity": 0.2, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 15, 9] },
        }, beforeId);

        map.value.addLayer({
            id: "route-line-shadow", type: "line", source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#000000", "line-opacity": 0.15, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 12, 15, 18], "line-offset": 1.5 },
        }, beforeId);

        map.value.addLayer({
            id: "route-line-halo", type: "line", source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#ffffff", "line-opacity": 1.0, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 10, 15, 15] },
        }, beforeId);

        map.value.addLayer({
            id: "route-line", type: "line", source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#4285F4", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 15, 11] },
        }, beforeId);

        // 目的地标记源
        if (!map.value.getSource("destination-source")) {
            map.value.addSource("destination-source", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] },
            });
            map.value.addLayer({
                id: "destination-layer",
                type: "symbol",
                source: "destination-source",
                layout: {
                    "icon-image": "destination-icon",
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                    "icon-ignore-placement": true,
                },
            });
        }
    }

    async function calculateRouteInRust(startId: number, possibleEnds: number[], heading: number | null, ownedDlcs: number[]): Promise<any> {
        return new Promise((resolve) => {
            let timeoutToken: any = null;
            const handler = (e: any) => {
                clearTimeout(timeoutToken);
                window.removeEventListener("route-result", handler);
                resolve(e.detail);
            };
            timeoutToken = setTimeout(() => {
                window.removeEventListener("route-result", handler);
                resolve(null);
            }, 10000);
            window.addEventListener("route-result", handler);
            const sent = sendWsMessage({
                type: "CALC_ROUTE",
                payload: { startId, possibleEnds, heading, ownedDlcs, selectedGame: settings.value.selectedGame },
            });
            if (!sent) { clearTimeout(timeoutToken); window.removeEventListener("route-result", handler); resolve(null); }
        });
    }

    async function handleRouteClick(clickCoords: [number, number], truckCoords: [number, number], truckHeading: number, sdkScale: number, createEndMarker: boolean, avgSpeed: number) {
        if (isCalculating.value || !isWorkerReady.value) return;
        isCalculating.value = true;
        isRouteActive.value = true;
        routeFound.value = null;
        savedDestination.value = clickCoords;

        try {
            const startConfig = findBestStartConfiguration(truckCoords, truckHeading, 50);
            if (!startConfig) { routeFound.value = false; isRouteActive.value = false; return; }
            startNodeId.value = startConfig.toId;

            const result = await findFlexibleRoute(startNodeId.value!, toRaw(clickCoords), truckHeading, toRaw(activeSettings.value.ownedDlcs));

            if (result) {
                const fullDisplayPath: [number, number][] = [];
                appendUniquePoint(fullDisplayPath, truckCoords);
                appendUniquePoint(fullDisplayPath, startConfig.projectedCoords);
                for (const point of result.path) appendUniquePoint(fullDisplayPath, point);

                currentRoutePath.value = Object.freeze(fullDisplayPath) as any;
                routePathProgressCache.value = buildPathProgressCache(fullDisplayPath);
                const stats = new Float32Array(result.node_kms.length * 2);
                for(let i=0; i<result.node_kms.length; i++){
                    stats[i*2] = result.node_kms[i];
                    stats[i*2+1] = result.node_kms[i] / getEffectiveSpeedKph(avgSpeed);
                }
                routeStatsCache.value = stats;
                fullRouteDirections.value = generateDirectionsList(result.node_sequence, new Float32Array(result.node_kms), new Int8Array(result.sequence_maneuvers), new Int8Array(result.sequence_exits), nodeCoords);
                destinationName.value = getGameLocationName(clickCoords[0], clickCoords[1]);
                setMapLibreData(toRaw(map.value!), "route-line", "LineString", toRaw(fullDisplayPath));
                if (createEndMarker) setMapLibreData(map.value!, "destination-source", "Point", toRaw(clickCoords));
                routeFound.value = true;
                currentRouteIndex.value = 0;
                routeCalculatedAt = Date.now();
                offRouteUpdates = 0;
                updateRouteSummary(0, avgSpeed);
                updateProfile("lastDestination", savedDestination.value);
                if (createEndMarker) announceStart(); else announceReroute();
            } else {
                routeFound.value = false;
                isRouteActive.value = false;
            }
        } catch (e) {
            routeFound.value = false;
            isRouteActive.value = false;
        } finally {
            isCalculating.value = false;
            isHandlingDeviation.value = false;
        }
    }

    const updateRouteProgress = (truckCoords: [number, number], truckHeading: number, sdkScale: number, avgSpeed: number) => {
        if (!currentRoutePath.value || currentRoutePath.value.length < 2 || !routeStatsCache.value) return;
        const path = currentRoutePath.value;
        const cache = routeStatsCache.value;
        let bestIndex = currentRouteIndex.value;
        let minSqDist = Infinity;
        const searchLimit = Math.min(path.length - 1, bestIndex + 300);
        const startSearch = Math.max(0, bestIndex - 30);

        for (let i = startSearch; i < searchLimit; i++) {
            const distSq = getSqDistToSegment(truckCoords, path[i]!, path[i + 1]!);
            if (distSq < minSqDist) { minSqDist = distSq; bestIndex = i; }
        }
        currentRouteIndex.value = bestIndex;

        const p1 = path[bestIndex]!; const p2 = path[bestIndex + 1]!;
        let projectedDistanceOnPath = routePathProgressCache.value?.[bestIndex] ?? 0;
        if (p1 && p2) {
            const slicedStartPoint = projectPointToSegment(truckCoords, p1, p2);
            projectedDistanceOnPath += getPlanarDistance(p1, slicedStartPoint);
            const remainingCoords = [truckCoords, slicedStartPoint, ...path.slice(bestIndex + 1)];
            setMapLibreData(toRaw(map.value!), "route-line", "LineString", toRaw(remainingCoords));
        }

        const totalPathDistance =
            routePathProgressCache.value?.[routePathProgressCache.value.length - 1] ??
            0;
        const progressPercent =
            totalPathDistance > 0
                ? projectedDistanceOnPath / totalPathDistance
                : bestIndex / Math.max(1, path.length - 1);
        const traveledKm = getRouteTotalKm(cache) * progressPercent;
        updateRouteSummary(traveledKm, avgSpeed);

        const now = Date.now();
        const isOffRoute = minSqDist > ROUTE_DEVIATION_THRESHOLD_SQ;
        offRouteUpdates = isOffRoute ? offRouteUpdates + 1 : 0;

        if (
            isOffRoute &&
            offRouteUpdates >= OFF_ROUTE_CONFIRMATION_UPDATES &&
            now - routeCalculatedAt > REROUTE_GRACE_MS &&
            !isHandlingDeviation.value &&
            !isCalculating.value &&
            savedDestination.value &&
            now - lastRerouteTime > REROUTE_COOLDOWN
        ) {
            isHandlingDeviation.value = true;
            lastRerouteTime = now;
            offRouteUpdates = 0;
            handleRouteClick(toRaw(savedDestination.value), truckCoords, truckHeading, sdkScale, false, avgSpeed);
        }
    };

    function clearRouteState() {
        if (!map.value) return;
        deleteMapLibreData(map.value, "route-line");
        deleteMapLibreData(map.value, "destination-source");
        isRouteActive.value = false;
        currentRoutePath.value = null;
        savedDestination.value = null;
        fullRouteDirections.value = [];
        routeStatsCache.value = null;
        routePathProgressCache.value = null;
        routeDistance.value = 0;
        routeEta.value = "";
        nextTurnDistance.value = 0;
        offRouteUpdates = 0;
        updateProfile("lastDestination", null);
        stopNavigationMode();
        resetVoiceState();
        isHandlingDeviation.value = false;
    }

    function findBestStartConfiguration(truckCoords: [number, number], _truckHeading: number, searchLimit: number = 50) {
        if (nodeCoords.size === 0) return null;
        const candidates = getClosestNodes(truckCoords, 10, searchLimit / 111);
        let closestNodeId: number | null = null; let minNodeDist = Infinity;
        for (const nodeId of candidates) {
            const nodePos = nodeCoords.get(nodeId);
            if (!nodePos) continue;
            const distSq = getSquaredDist(truckCoords, nodePos);
            if (distSq < minNodeDist) { minNodeDist = distSq; closestNodeId = nodeId; }
        }
        if (closestNodeId !== null) {
            const nodePos = nodeCoords.get(closestNodeId);
            if (!nodePos) return null;
            return { type: "yard", fromId: closestNodeId, toId: closestNodeId, projectedCoords: nodePos };
        }
        return null;
    }

    async function findFlexibleRoute(startNodeId: number, targetCoords: [number, number], truckHeading: number, ownedDlcs: number[]) {
        const SEARCH_RADII = [1, 2, 4, 8, 16, 32, 100, 300];
        for (const radius of SEARCH_RADII) {
            const candidates = getClosestNodes(targetCoords, radius, 0.1);
            if (candidates.length === 0) continue;
            const result = await calculateRouteInRust(startNodeId, candidates, truckHeading, ownedDlcs);
            if (result) return result;
        }
        return null;
    }

    return {
        destinationName, routeDistance, routeEta, isCalculating, routeFound,
        currentRoutePath, isWorkerReady, isRouteActive, fullRouteDirections,
        nextTurnDistance, initWorkerData, destroyWorker, setupRouteLayer,
        handleRouteClick, updateRouteProgress, clearRouteState,
    };
};
