import maplibregl from "maplibre-gl";
import { generateDestinationIcon } from "~/assets/utils/map/markers";
import {
    getSqDistToSegment,
    DEVIATION_THRESHOLD_SQ,
    getSquaredDist,
} from "~/assets/utils/map/maths";
import { haversine } from "~/assets/utils/routing/helpers";
import {
    deleteMapLibreData,
    setMapLibreData,
} from "~/assets/utils/map/helpers";
import {
    generateDirectionsList,
    type DirectionStep,
} from "~/assets/utils/routing/directions";

export type GuidancePhase = "cruise" | "prepare" | "action" | "arrive";

export interface ActiveRouteGuidance {
    current: DirectionStep | null;
    following: DirectionStep | null;
    distanceKm: number;
    phase: GuidancePhase;
    instruction: string;
}

type RouteAnnouncement = "start" | "reroute" | "silent";

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
    const { getClosestNodes, getClosestDestinationNodes } = useGraphSystem();
    const { settings, activeSettings, updateProfile } = useSettings();
    const { processNavigationUpdate, resetVoiceState, announceStart, announceReroute } = useVoiceNavigation();
    const { sendWsMessage } = useEtsTelemetry();

    // 状态管理
    const currentRoutePath = shallowRef<[number, number][] | null>(null);
    const routeStatsCache = shallowRef<Float32Array | null>(null);
    const routePathKmCache = shallowRef<Float64Array | null>(null);
    const destinationName = ref<string>("");
    const routeDistance = ref<number>(0);
    const routeEta = ref<string>("");
    const savedDestination = ref<[number, number] | null>(null);
    const savedDestinationName = ref<string | null>(null);
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
    const activeGuidance = shallowRef<ActiveRouteGuidance | null>(null);

    const isHandlingDeviation = ref(false);
    let lastRerouteTime = 0;
    let routeCalculatedAt = 0;
    let offRouteUpdates = 0;
    let lastRouteProgressKm = 0;
    const REROUTE_COOLDOWN = 15000;
    const REROUTE_GRACE_MS = 5000;
    const OFF_ROUTE_CONFIRMATION_UPDATES = 6;
    const ROUTE_DEVIATION_THRESHOLD_SQ = DEVIATION_THRESHOLD_SQ * 4;
    const MANEUVER_PASSED_TOLERANCE_KM = 0.012;

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

    function projectPointToSegmentWithRatio(p: [number, number], v: [number, number], w: [number, number]) {
        const l2 = getSquaredDist(v, w);
        if (l2 === 0) return { projected: [v[0], v[1]] as [number, number], t: 0 };
        let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
        t = Math.max(0, Math.min(1, t));
        return {
            projected: [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])] as [number, number],
            t,
        };
    }

    function appendDisplayPoint(points: [number, number][], kms: number[], point: [number, number], km: number) {
        const last = points[points.length - 1];
        if (!last || getSquaredDist(last, point) > 0.000000000001) {
            points.push(point);
            kms.push(km);
        } else if (kms.length > 0) {
            kms[kms.length - 1] = Math.max(kms[kms.length - 1]!, km);
        }
    }

    function findMatchingPointIndex(
        points: [number, number][],
        target: [number, number],
        startIndex: number,
    ) {
        for (let i = startIndex; i < points.length; i++) {
            if (getSquaredDist(points[i]!, target) < 0.000000000001) {
                return i;
            }
        }
        return -1;
    }

    function assignEdgeKmRange(
        points: [number, number][],
        cache: Float64Array,
        assigned: boolean[],
        startIndex: number,
        endIndex: number,
        startKm: number,
        endKm: number,
    ) {
        const edgeKm = Math.max(0, endKm - startKm);
        let totalMeters = 0;
        const segmentMeters: number[] = [];

        for (let i = startIndex; i < endIndex; i++) {
            const meters = haversine(points[i]!, points[i + 1]!);
            segmentMeters.push(meters);
            totalMeters += meters;
        }

        let walkedMeters = 0;
        for (let i = startIndex; i <= endIndex; i++) {
            const ratio = totalMeters > 0 ? walkedMeters / totalMeters : 0;
            cache[i] = startKm + edgeKm * ratio;
            assigned[i] = true;
            walkedMeters += segmentMeters[i - startIndex] ?? 0;
        }
    }

    function buildResultPathKmCache(
        points: [number, number][],
        nodeSequence: number[],
        nodeKms: number[],
    ) {
        const cache = new Float64Array(points.length);
        const assigned = new Array<boolean>(points.length).fill(false);
        let searchFrom = 0;

        for (let i = 0; i < nodeSequence.length - 1; i++) {
            const startCoord = nodeCoords.get(nodeSequence[i]!);
            const endCoord = nodeCoords.get(nodeSequence[i + 1]!);
            if (!startCoord || !endCoord) continue;

            let startIndex = findMatchingPointIndex(points, startCoord, searchFrom);
            if (startIndex < 0) startIndex = searchFrom;

            let endIndex = findMatchingPointIndex(
                points,
                endCoord,
                Math.min(startIndex + 1, points.length - 1),
            );
            if (endIndex < 0 || endIndex <= startIndex) {
                endIndex = Math.min(points.length - 1, startIndex + 1);
            }

            assignEdgeKmRange(
                points,
                cache,
                assigned,
                startIndex,
                endIndex,
                nodeKms[i] ?? 0,
                nodeKms[i + 1] ?? nodeKms[i] ?? 0,
            );
            searchFrom = endIndex;
        }

        let lastKnownKm = 0;
        for (let i = 0; i < cache.length; i++) {
            if (assigned[i]) {
                lastKnownKm = cache[i]!;
            } else {
                cache[i] = lastKnownKm;
            }
        }

        return cache;
    }

    function getRouteTotalKm(cache: Float32Array) {
        return cache.length >= 2 ? cache[cache.length - 2] || 0 : 0;
    }

    function getRouteTotalHours(cache: Float32Array) {
        return cache.length >= 2 ? cache[cache.length - 1] || 0 : 0;
    }

    function getHoursAtKm(cache: Float32Array, targetKm: number) {
        if (cache.length < 2) return 0;

        for (let i = 2; i < cache.length; i += 2) {
            const previousKm = cache[i - 2]!;
            const previousHours = cache[i - 1]!;
            const currentKm = cache[i]!;
            const currentHours = cache[i + 1]!;

            if (targetKm <= currentKm) {
                const segmentKm = currentKm - previousKm;
                const ratio =
                    segmentKm > 0
                        ? (targetKm - previousKm) / segmentKm
                        : 0;
                return previousHours + (currentHours - previousHours) * ratio;
            }
        }

        return getRouteTotalHours(cache);
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

    function getStepCumulativeKm(step: DirectionStep, totalKm: number) {
        return step.cumulativeKm ?? (step.type === "destination" ? totalKm : 0);
    }

    function getActionDistanceKm(avgSpeed: number, stepType?: DirectionStep["type"]) {
        const speedKph = getEffectiveSpeedKph(avgSpeed);
        const leadSeconds =
            stepType === "exit-highway" ||
            stepType === "slight-left" ||
            stepType === "slight-right"
                ? 5
                : 4;
        return Math.min(0.16, Math.max(0.045, (speedKph * leadSeconds) / 3600));
    }

    function formatGuidanceInstruction(step: DirectionStep | null, phase: GuidancePhase) {
        if (!step) return "沿路线行驶";
        if (step.type === "destination") {
            return phase === "arrive" ? "到达目的地" : "继续前往目的地";
        }
        if (phase === "cruise") return "请直行";
        if (phase === "prepare") return `准备${step.text}`;
        if (step.text.startsWith("从") || step.text.startsWith("靠")) return step.text;
        return `请${step.text}`;
    }

    function updateActiveGuidance(safeTraveledKm: number, totalKm: number, avgSpeed: number) {
        const navigableSteps = fullRouteDirections.value.filter(
            (step) => step.type !== "depart",
        );
        const currentIndex = navigableSteps.findIndex(
            (step) =>
                getStepCumulativeKm(step, totalKm) >
                safeTraveledKm - MANEUVER_PASSED_TOLERANCE_KM,
        );

        if (currentIndex < 0) {
            activeGuidance.value = {
                current: null,
                following: null,
                distanceKm: Math.max(0, totalKm - safeTraveledKm),
                phase: "cruise",
                instruction: "沿路线行驶",
            };
            return activeGuidance.value;
        }

        const current = navigableSteps[currentIndex]!;
        const following = navigableSteps[currentIndex + 1] ?? null;
        const distanceKm = Math.max(
            0,
            getStepCumulativeKm(current, totalKm) - safeTraveledKm,
        );
        const actionDistanceKm = getActionDistanceKm(avgSpeed, current.type);
        const prepareDistanceKm = Math.max(
            actionDistanceKm * 2,
            activeSettings.value.maneuverDistance,
        );
        const phase: GuidancePhase =
            current.type === "destination" && distanceKm <= actionDistanceKm
                ? "arrive"
                : distanceKm <= actionDistanceKm
                  ? "action"
                  : distanceKm <= prepareDistanceKm
                    ? "prepare"
                    : "cruise";

        activeGuidance.value = {
            current,
            following,
            distanceKm,
            phase,
            instruction: formatGuidanceInstruction(current, phase),
        };
        return activeGuidance.value;
    }

    function updateRouteSummary(traveledKm: number, avgSpeed: number) {
        const cache = routeStatsCache.value;
        if (!cache) return;

        const totalKm = getRouteTotalKm(cache);
        const safeTraveledKm = Math.min(Math.max(traveledKm, 0), totalKm);
        const remainingKm = Math.max(0, totalKm - safeTraveledKm);
        const totalHours = getRouteTotalHours(cache);
        const elapsedHours = getHoursAtKm(cache, safeTraveledKm);
        const fallbackHours =
            remainingKm / getEffectiveSpeedKph(avgSpeed);

        routeDistance.value = remainingKm;
        routeEta.value = formatDuration(
            totalHours > 0 ? Math.max(0, totalHours - elapsedHours) : fallbackHours,
        );

        const guidance = updateActiveGuidance(safeTraveledKm, totalKm, avgSpeed);
        nextTurnDistance.value = guidance?.current
            ? guidance.distanceKm
            : remainingKm;

        if (guidance?.current) {
            processNavigationUpdate(
                nextTurnDistance.value,
                guidance.current.id,
                guidance.current.text,
                guidance.current.type === "destination",
                avgSpeed,
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

    async function handleRouteClick(clickCoords: [number, number], truckCoords: [number, number], truckHeading: number, sdkScale: number, announcement: RouteAnnouncement, avgSpeed: number, destinationLabel?: string) {
        if (isCalculating.value || !isWorkerReady.value) return;
        isCalculating.value = true;
        isRouteActive.value = true;
        routeFound.value = null;
        savedDestination.value = clickCoords;
        savedDestinationName.value = destinationLabel ?? null;

        try {
            const startConfig = findBestStartConfiguration(truckCoords, truckHeading, 50);
            if (!startConfig) { routeFound.value = false; isRouteActive.value = false; return; }
            startNodeId.value = startConfig.toId;

            const result = await findFlexibleRoute(startNodeId.value!, toRaw(clickCoords), truckHeading, toRaw(activeSettings.value.ownedDlcs));

            if (result) {
                const resultPathKmCache = buildResultPathKmCache(
                    result.path,
                    result.node_sequence,
                    result.node_kms,
                );
                const fullDisplayPath: [number, number][] = [];
                const fullDisplayPathKms: number[] = [];
                appendDisplayPoint(fullDisplayPath, fullDisplayPathKms, truckCoords, 0);
                appendDisplayPoint(fullDisplayPath, fullDisplayPathKms, startConfig.projectedCoords, 0);
                for (let i = 0; i < result.path.length; i++) {
                    appendDisplayPoint(
                        fullDisplayPath,
                        fullDisplayPathKms,
                        result.path[i]!,
                        resultPathKmCache[i] ?? 0,
                    );
                }

                currentRoutePath.value = Object.freeze(fullDisplayPath) as any;
                routePathKmCache.value = new Float64Array(fullDisplayPathKms);
                const nodeKms = Array.isArray(result.node_kms) ? result.node_kms : [];
                const nodeHours = Array.isArray(result.node_hours) ? result.node_hours : null;
                const stats = new Float32Array(nodeKms.length * 2);
                for (let i = 0; i < nodeKms.length; i++) {
                    const km = nodeKms[i] ?? 0;
                    stats[i * 2] = km;
                    stats[i * 2 + 1] = nodeHours?.[i] ?? km / getEffectiveSpeedKph(avgSpeed);
                }
                routeStatsCache.value = stats;
                fullRouteDirections.value = generateDirectionsList(result.node_sequence, new Float32Array(nodeKms), new Int8Array(result.sequence_maneuvers), new Int8Array(result.sequence_exits), nodeCoords);
                destinationName.value =
                    savedDestinationName.value ||
                    getGameLocationName(clickCoords[0], clickCoords[1]);
                setMapLibreData(toRaw(map.value!), "route-line", "LineString", toRaw(fullDisplayPath));
                setMapLibreData(map.value!, "destination-source", "Point", toRaw(clickCoords));
                routeFound.value = true;
                currentRouteIndex.value = 0;
                lastRouteProgressKm = 0;
                routeCalculatedAt = Date.now();
                offRouteUpdates = 0;
                updateRouteSummary(0, avgSpeed);
                updateProfile("lastDestination", savedDestination.value);
                if (announcement === "start") announceStart();
                else if (announcement === "reroute") announceReroute();
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
        if (!currentRoutePath.value || currentRoutePath.value.length < 2 || !routeStatsCache.value || !routePathKmCache.value) return;
        const path = currentRoutePath.value;
        const kmCache = routePathKmCache.value;
        let bestIndex = currentRouteIndex.value;
        let minSqDist = Infinity;
        const searchLimit = Math.min(path.length - 1, bestIndex + 300);
        const startSearch = Math.max(0, bestIndex - 30);

        for (let i = startSearch; i < searchLimit; i++) {
            const distSq = getSqDistToSegment(truckCoords, path[i]!, path[i + 1]!);
            if (distSq < minSqDist) { minSqDist = distSq; bestIndex = i; }
        }
        currentRouteIndex.value = bestIndex;

        const p1 = path[bestIndex]!;
        const p2 = path[bestIndex + 1]!;
        if (p1 && p2) {
            const { projected, t } = projectPointToSegmentWithRatio(
                truckCoords,
                p1,
                p2,
            );
            const segmentStartKm = kmCache[bestIndex] ?? 0;
            const segmentEndKm = kmCache[bestIndex + 1] ?? segmentStartKm;
            const progressKm =
                segmentStartKm +
                Math.max(0, segmentEndKm - segmentStartKm) * t;
            lastRouteProgressKm = Math.max(lastRouteProgressKm, progressKm);

            const remainingCoords = [
                truckCoords,
                projected,
                ...path.slice(bestIndex + 1),
            ];
            setMapLibreData(toRaw(map.value!), "route-line", "LineString", toRaw(remainingCoords));
        }

        updateRouteSummary(lastRouteProgressKm, avgSpeed);

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
            handleRouteClick(toRaw(savedDestination.value), truckCoords, truckHeading, sdkScale, "reroute", avgSpeed, savedDestinationName.value ?? undefined);
        }
    };

    function clearRouteState() {
        if (!map.value) return;
        deleteMapLibreData(map.value, "route-line");
        deleteMapLibreData(map.value, "destination-source");
        isRouteActive.value = false;
        currentRoutePath.value = null;
        savedDestination.value = null;
        savedDestinationName.value = null;
        fullRouteDirections.value = [];
        routeStatsCache.value = null;
        routePathKmCache.value = null;
        routeDistance.value = 0;
        routeEta.value = "";
        nextTurnDistance.value = 0;
        activeGuidance.value = null;
        offRouteUpdates = 0;
        lastRouteProgressKm = 0;
        updateProfile("lastDestination", null);
        stopNavigationMode();
        resetVoiceState();
        isHandlingDeviation.value = false;
    }

    function findBestStartConfiguration(truckCoords: [number, number], _truckHeading: number, searchLimit: number = 50) {
        if (nodeCoords.size === 0) return null;
        const headingCandidates = getClosestDestinationNodes(
            truckCoords,
            _truckHeading,
            8,
        );
        if (headingCandidates.length > 0) {
            const nodePos = nodeCoords.get(headingCandidates[0]!);
            if (nodePos) {
                return { type: "road", fromId: headingCandidates[0]!, toId: headingCandidates[0]!, projectedCoords: nodePos };
            }
        }

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
        const snappedCandidates = getClosestDestinationNodes(
            targetCoords,
            truckHeading,
            24,
        );
        const candidateCounts = [2, 4, 8, 12, 16, 24];

        for (const count of candidateCounts) {
            const candidates = snappedCandidates.slice(0, count);
            if (candidates.length === 0) continue;
            const result = await calculateRouteInRust(startNodeId, candidates, truckHeading, ownedDlcs);
            if (result) return result;
        }

        const fallbackCandidateCounts = [1, 2, 4, 8, 16, 32, 100, 300];
        for (const count of fallbackCandidateCounts) {
            const candidates = getClosestNodes(targetCoords, count, 0.1);
            if (candidates.length === 0) continue;
            const result = await calculateRouteInRust(
                startNodeId,
                candidates,
                truckHeading,
                ownedDlcs,
            );
            if (result) return result;
        }

        return null;
    }

    return {
        destinationName, routeDistance, routeEta, isCalculating, routeFound,
        currentRoutePath, isWorkerReady, isRouteActive, fullRouteDirections,
        nextTurnDistance, activeGuidance, initWorkerData, destroyWorker, setupRouteLayer,
        handleRouteClick, updateRouteProgress, clearRouteState,
    };
};
