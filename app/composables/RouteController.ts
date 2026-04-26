import maplibregl from "maplibre-gl";
import { generateDestinationIcon } from "~/assets/utils/map/markers";
import {
    getBearing,
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

export const useRouteController = (
    map: Ref<maplibregl.Map | null>,
    adjacency: Map<number, any>,
    nodeCoords: Map<number, [number, number]>,
    stopNavigationMode: () => void,
) => {
    const { getGameLocationName, getWorkerCityData } = useCityData();
    const { getClosestNodes } = useGraphSystem();
    const { settings, activeSettings, updateGlobal, updateProfile } =
        useSettings();
    const { processNavigationUpdate, resetVoiceState, announceStart, announceReroute } = useVoiceNavigation();
    const { sendWsMessage } = useEtsTelemetry();

    const currentRoutePath = shallowRef<[number, number][] | null>(null);
    const routeStatsCache = shallowRef<Float32Array | null>(null);

    const destinationName = ref<string>("");
    const routeDistance = ref<number>(0);
    const routeEta = ref<string>("");

    const savedDestination = ref<[number, number] | null>(null);

    const isRouteActive = ref(false);
    const isYardStart = ref(false);

    const isTruckInYard = ref(false);

    const startNodeId = ref<number | null>(null);
    const endNodeId = ref<number | null>(null);
    const lastMathPos = ref<[number, number] | null>(null);

    const isCalculating = ref(false);
    const routeFound = ref<boolean | null>(null);

    const currentRouteIndex = ref(0);
    const isWorkerReady = ref(false);

    const fullRouteDirections = ref<DirectionStep[]>([]);
    const nextTurnDistance = ref<number>(0);

    watch(
        () => activeSettings.value.themeColor,
        async (newColor) => {
            if (map.value && map.value.hasImage("destination-icon")) {
                const newPinImg = await generateDestinationIcon(newColor);
                map.value.updateImage("destination-icon", newPinImg);
            }
        },
    );

    watch(
        () => activeSettings.value.routeColor,
        (newColor) => {
            if (map.value && map.value.getLayer("route-line")) {
                map.value.setPaintProperty(
                    "route-line",
                    "line-color",
                    newColor,
                );
            }
        },
    );

    function initWorkerData(
        nodesArray: any[],
        graphBuffer: ArrayBuffer | null,
        geometryBuffer: ArrayBuffer | null,
    ) {
        // Backend handles data now, so we just mark as ready
        isWorkerReady.value = true;
    }

    function projectPointToSegment(
        p: [number, number],
        v: [number, number],
        w: [number, number],
    ): [number, number] {
        const l2 = getSquaredDist(v, w);
        if (l2 === 0) return [v[0], v[1]];
        let t =
            ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) /
            l2;
        t = Math.max(0, Math.min(1, t));
        return [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])];
    }

    function calculateRouteInRust(
        startId: number,
        possibleEnds: number[],
        heading: number | null,
        ownedDlcs: number[],
    ): Promise<any> {
        return new Promise((resolve) => {
            const handler = (e: any) => {
                window.removeEventListener("route-result", handler);
                resolve(e.detail);
            };

            window.addEventListener("route-result", handler);

            const sent = sendWsMessage({
                type: "CALC_ROUTE",
                payload: {
                    startId,
                    possibleEnds,
                    heading,
                    ownedDlcs,
                    selectedGame: settings.value.selectedGame,
                },
            });

            if (!sent) {
                console.error("[RustBridge] Failed to send route request");
                window.removeEventListener("route-result", handler);
                resolve(null);
            }
        });
    }

    function findBestStartConfiguration(
        truckCoords: [number, number],
        truckHeading: number,
        searchLimit: number = 50,
    ) {
        if (nodeCoords.size === 0) {
            console.error("CRITICAL: Graph data is empty!");
            return null;
        }

        const candidates = getClosestNodes(truckCoords, 10, searchLimit / 111);
        let closestNodeId: number | null = null; let minNodeDist = Infinity;

        for (const nodeId of candidates) {
            const nodePos = nodeCoords.get(nodeId);
            if (!nodePos) continue;

            const distSq = getSquaredDist(truckCoords, nodePos);
            if (distSq < minNodeDist) {
                minNodeDist = distSq;
                closestNodeId = nodeId;
            }
        }

        if (closestNodeId !== null) {
            const nodePos = nodeCoords.get(closestNodeId);
            if (!nodePos) return null;

            return {
                type: "yard",
                fromId: closestNodeId,
                toId: closestNodeId,
                projectedCoords: nodePos,
            };
        }

        return null;
    }

    async function findFlexibleRoute(
        startNodeId: number,
        targetCoords: [number, number],
        truckHeading: number,
        startType: "road" | "yard",
        projectedStartCoords: [number, number],
        sdkScale: number,
        avgSpeed: number,
    ) {
        const SEARCH_RADII = [1, 2, 4, 8, 16, 32, 100, 300];
        const userDlcs = toRaw(activeSettings.value.ownedDlcs);

        for (const radius of SEARCH_RADII) {
            const candidates = getClosestNodes(targetCoords, radius, 0.1);
            if (candidates.length === 0) continue;

            const result = await calculateRouteInRust(
                startNodeId,
                candidates,
                truckHeading,
                userDlcs,
            );

            if (result) return result;
        }
        return null;
    }

    function localBuildStats(path: [number, number][], avgSpeed: number) {
        const cache = new Float32Array(path.length * 2);
        let totalKm = 0;
        let totalHours = 0;
        cache[0] = 0; cache[1] = 0;
        for(let i=0; i<path.length-1; i++) {
            const p1 = path[i]!; const p2 = path[i+1]!;
            const dx = (p2[0]-p1[0])*111*0.65;
            const dy = (p2[1]-p1[1])*111;
            const dist = Math.sqrt(dx*dx + dy*dy);
            totalKm += dist;
            totalHours += dist / avgSpeed;
            cache[(i+1)*2] = totalKm;
            cache[(i+1)*2+1] = totalHours;
        }
        return cache;
    }

    function drawRouteOnMap(coords: [number, number][]) {
        if (!map.value) return;
        setMapLibreData(toRaw(map.value), "route-line", "LineString", toRaw(coords));
    }

    function addDestinationMarker(coords: [number, number]) {
        if (!map.value) return;
        setMapLibreData(map.value, "destination-source", "Point", coords);
    }

    async function setupRouteLayer() {
        if (!map.value) return;
        if (map.value.getSource("route-line")) return;

        if (!map.value.hasImage("destination-icon")) {
            const pinImg = await generateDestinationIcon();
            map.value.addImage("destination-icon", pinImg, { pixelRatio: 2.5 });
        }

        map.value.addSource("route-line", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
        });

        const beforeId = map.value.getLayer("all-sprites") ? "all-sprites" : undefined;

        map.value.addLayer({
            id: "route-line-rail",
            type: "line",
            source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": "#475569",
                "line-opacity": 0.2,
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 15, 9],
            },
        }, beforeId);

        map.value.addLayer({
            id: "route-line-shadow",
            type: "line",
            source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": "#000000",
                "line-opacity": 0.15,
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, 12, 15, 18],
                "line-offset": 1.5,
            },
        }, beforeId);

        map.value.addLayer({
            id: "route-line-halo",
            type: "line",
            source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": "#ffffff",
                "line-opacity": 1.0,
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, 10, 15, 15],
            },
        }, beforeId);

        map.value.addLayer({
            id: "route-line",
            type: "line",
            source: "route-line",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": "#4285F4",
                "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 15, 11],
            },
        }, beforeId);

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

    async function handleRouteClick(
        clickCoords: [number, number],
        truckCoords: [number, number],
        truckHeading: number,
        sdkScale: number,
        createEndMarker: boolean,
        avgSpeed: number,
    ) {
        if (isCalculating.value || !isWorkerReady.value) return;

        isCalculating.value = true;
        routeFound.value = null;
        savedDestination.value = clickCoords;

        try {
            const startConfig = findBestStartConfiguration(truckCoords, truckHeading, 50);
            if (!startConfig) {
                routeFound.value = false;
                return;
            }
            isYardStart.value = startConfig.type === "yard";
            startNodeId.value = startConfig.toId;

            const result = await findFlexibleRoute(
                startNodeId.value!,
                toRaw(clickCoords),
                truckHeading,
                startConfig.type as "road" | "yard",
                startConfig.projectedCoords,
                sdkScale,
                avgSpeed,
            );

            if (result) {
                isRouteActive.value = true;
                endNodeId.value = result.node_sequence[result.node_sequence.length-1];

                const fullDisplayPath = [startConfig.projectedCoords, ...result.path];
                currentRoutePath.value = Object.freeze(fullDisplayPath) as any;

                const stats = localBuildStats(fullDisplayPath, avgSpeed);
                routeStatsCache.value = stats;

                const lastIdx = stats.length - 2;
                routeDistance.value = Math.round(stats[lastIdx]!);
                const totalHours = stats[lastIdx + 1]!;
                const h = Math.floor(totalHours);
                const m = Math.round((totalHours - h) * 60);
                routeEta.value = `${h}小时 ${m}分钟`;

                destinationName.value = getGameLocationName(clickCoords[0], clickCoords[1]);
                
                fullRouteDirections.value = generateDirectionsList(
                    result.node_sequence,
                    new Float32Array(result.node_sequence.length),
                    new Int8Array(result.node_sequence.length),
                    new Int8Array(result.node_sequence.length),
                    nodeCoords,
                );

                drawRouteOnMap(fullDisplayPath);
                if (createEndMarker) addDestinationMarker(toRaw(clickCoords));

                routeFound.value = true;
                currentRouteIndex.value = 0;
                updateProfile("lastDestination", savedDestination.value);
                
                if (createEndMarker) announceStart(); else announceReroute();
            } else {
                routeFound.value = false;
            }
        } catch (e) {
            console.log(`Route calculation Failed: ${e}`);
            isRouteActive.value = false;
        } finally {
            isCalculating.value = false;
        }
    }

    const updateRouteProgress = (
        truckCoords: [number, number],
        truckHeading: number,
        sdkScale: number,
        avgSpeed: number,
    ) => {
        if (!currentRoutePath.value || currentRoutePath.value.length < 2) return;
        const cache = routeStatsCache.value;
        if (!cache) return;

        if (lastMathPos.value) {
            const sqDist = getSquaredDist(lastMathPos.value, truckCoords);
            if (sqDist < 0.000000001) return;
        }
        lastMathPos.value = truckCoords;

        const path = currentRoutePath.value;
        let bestIndex = currentRouteIndex.value;
        let minSqDist = Infinity;

        const searchLimit = Math.min(path.length - 1, bestIndex + 500);
        const startSearch = Math.max(0, bestIndex - 5);

        for (let i = startSearch; i < searchLimit; i++) {
            const distSq = getSqDistToSegment(truckCoords, path[i]!, path[i + 1]!);
            if (distSq < minSqDist) {
                minSqDist = distSq;
                bestIndex = i;
            }
        }

        currentRouteIndex.value = bestIndex;

        const p1 = path[bestIndex]!;
        const p2 = path[bestIndex + 1]!;
        if (p1 && p2) {
            const slicedStartPoint = projectPointToSegment(truckCoords, p1, p2);
            const remainingCoords = [truckCoords, slicedStartPoint, ...path.slice(bestIndex + 1)];
            if (remainingCoords.length >= 2) drawRouteOnMap(remainingCoords);
        }

        const distToEndSq = getSquaredDist(truckCoords, path[path.length - 1]!);
        if (distToEndSq < 0.0000005) {
            clearRouteState();
            return;
        }

        const lastIdx = (path.length - 1) * 2;
        const currentIdx = bestIndex * 2;
        const remKm = cache[lastIdx]! - cache[currentIdx]!;
        const remHours = cache[lastIdx + 1]! - cache[currentIdx]!;
        
        routeDistance.value = Math.round(remKm);
        if (remHours > 0) {
            const h = Math.floor(remHours);
            const m = Math.round((remHours - h) * 60);
            routeEta.value = `${h}小时 ${m}分钟`;
        } else {
            routeEta.value = "即将到达";
        }

        if (minSqDist > DEVIATION_THRESHOLD_SQ) {
            if (!isCalculating.value && savedDestination.value) {
                console.log("Deviation detected! Recalculating...");
                handleRouteClick(toRaw(savedDestination.value), truckCoords, truckHeading, sdkScale, false, avgSpeed);
            }
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
        updateProfile("lastDestination", null);
        stopNavigationMode();
        resetVoiceState();
    }

    return {
        destinationName,
        routeDistance,
        routeEta,
        isCalculating,
        routeFound,
        currentRoutePath,
        isWorkerReady,
        isRouteActive,
        fullRouteDirections,
        nextTurnDistance,
        initWorkerData,
        setupRouteLayer,
        handleRouteClick,
        updateRouteProgress,
        clearRouteState,
    };
};
