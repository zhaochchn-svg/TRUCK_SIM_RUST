import RBush from "rbush";
import { loadGraph } from "~/assets/utils/routing/clientGraph";
import { haversine } from "~/assets/utils/routing/helpers";
import { getAngleDiff, getBearing } from "~/assets/utils/map/maths";

interface NodeIndexItem {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    id: number;
    coord: [number, number];
}

interface EdgeIndexItem {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    fromId: number;
    toId: number;
    startIndex: number;
    pointCount: number;
}

const adjacency = new Map<number, any>();
const nodeCoords = new Map<number, [number, number]>();
const nodeTree = new RBush<NodeIndexItem>();
const edgeTree = new RBush<EdgeIndexItem>();
let geometryCoords: Float32Array | null = null;

const loading = ref(true);
const progress = ref(0);

export function useGraphSystem() {
    let rawNodesForWorker: any[] = [];

    let workerGraphBuffer: ArrayBuffer | null = null;
    let workerGeometryBuffer: ArrayBuffer | null = null;

    const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

    function getClosestNodes(
        target: [number, number],
        limit = 5,
        radiusDeg = 0.02,
    ): number[] {
        const candidates = nodeTree.search({
            minX: target[0] - radiusDeg,
            minY: target[1] - radiusDeg,
            maxX: target[0] + radiusDeg,
            maxY: target[1] + radiusDeg,
        });
        if (candidates.length === 0) return [];
        return candidates
            .map((item) => ({
                id: item.id,
                dist: haversine(target, item.coord),
            }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, limit)
            .map((c) => c.id);
    }

    function projectPointToSegment(
        point: [number, number],
        start: [number, number],
        end: [number, number],
    ) {
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const denom = dx * dx + dy * dy;

        if (denom === 0) {
            return {
                projected: [start[0], start[1]] as [number, number],
                heading: 0,
            };
        }

        let t =
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denom;
        t = Math.max(0, Math.min(1, t));

        return {
            projected: [start[0] + dx * t, start[1] + dy * t] as [
                number,
                number,
            ],
            heading: getBearing(start, end),
        };
    }

    function scoreDestinationEdge(
        edge: EdgeIndexItem,
        target: [number, number],
        preferredHeading: number | null,
    ) {
        const fromCoord = nodeCoords.get(edge.fromId);
        const toCoord = nodeCoords.get(edge.toId);

        if (!fromCoord || !toCoord) return null;

        let bestDistanceMeters = Infinity;
        let bestHeading = getBearing(fromCoord, toCoord);

        if (geometryCoords && edge.pointCount > 1) {
            for (let point = 0; point < edge.pointCount - 1; point++) {
                const baseIndex = edge.startIndex + point * 2;
                const segStart: [number, number] = [
                    geometryCoords[baseIndex]!,
                    geometryCoords[baseIndex + 1]!,
                ];
                const segEnd: [number, number] = [
                    geometryCoords[baseIndex + 2]!,
                    geometryCoords[baseIndex + 3]!,
                ];

                const { projected, heading } = projectPointToSegment(
                    target,
                    segStart,
                    segEnd,
                );
                const dist = haversine(target, projected);

                if (dist < bestDistanceMeters) {
                    bestDistanceMeters = dist;
                    bestHeading = heading;
                }
            }
        }

        if (!Number.isFinite(bestDistanceMeters)) {
            const { projected, heading } = projectPointToSegment(
                target,
                fromCoord,
                toCoord,
            );
            bestDistanceMeters = haversine(target, projected);
            bestHeading = heading;
        }

        const headingDiff =
            preferredHeading === null
                ? 0
                : getAngleDiff(preferredHeading, bestHeading);

        let headingPenaltyMeters = 0;
        if (preferredHeading !== null) {
            if (headingDiff > 150) headingPenaltyMeters = 250;
            else if (headingDiff > 110) headingPenaltyMeters = 120;
            else if (headingDiff > 75) headingPenaltyMeters = 50;
            else if (headingDiff > 45) headingPenaltyMeters = 15;
        }

        const primaryNodeId =
            preferredHeading === null
                ? haversine(target, fromCoord) <= haversine(target, toCoord)
                    ? edge.fromId
                    : edge.toId
                : headingDiff <= 90
                  ? edge.toId
                  : edge.fromId;

        return {
            nodeId: primaryNodeId,
            score: bestDistanceMeters + headingPenaltyMeters,
        };
    }

    function getClosestDestinationNodes(
        target: [number, number],
        preferredHeading: number | null = null,
        limit = 12,
    ): number[] {
        const searchRadiiDeg = [0.0015, 0.003, 0.006, 0.012, 0.02];
        const scoredNodes = new Map<number, number>();

        for (const radiusDeg of searchRadiiDeg) {
            const edgeCandidates = edgeTree.search({
                minX: target[0] - radiusDeg,
                minY: target[1] - radiusDeg,
                maxX: target[0] + radiusDeg,
                maxY: target[1] + radiusDeg,
            });

            if (edgeCandidates.length === 0) continue;

            for (const edge of edgeCandidates) {
                const scored = scoreDestinationEdge(
                    edge,
                    target,
                    preferredHeading,
                );
                if (!scored) continue;

                const currentScore = scoredNodes.get(scored.nodeId);
                if (
                    currentScore === undefined ||
                    scored.score < currentScore
                ) {
                    scoredNodes.set(scored.nodeId, scored.score);
                }
            }

            if (scoredNodes.size >= limit) break;
        }

        const sortedNodes = [...scoredNodes.entries()]
            .sort((a, b) => a[1] - b[1])
            .slice(0, limit)
            .map(([nodeId]) => nodeId);

        if (sortedNodes.length > 0) return sortedNodes;

        return getClosestNodes(target, limit, 0.02);
    }

    const initializeGraphData = async () => {
        loading.value = true;
        progress.value = 0;

        const ghostInterval = setInterval(() => {
            if (progress.value < 85)
                progress.value += Math.floor(Math.random() * 3) + 1;
        }, 200);

        try {
            const { graphBuffer, geometryBuffer } = await loadGraph();

            workerGraphBuffer = graphBuffer;
            workerGeometryBuffer = geometryBuffer;

            const graphF32 = new Float32Array(graphBuffer);
            const geometryF32 = new Float32Array(geometryBuffer);
            geometryCoords = geometryF32;

            adjacency.clear();
            nodeCoords.clear();
            nodeTree.clear();
            edgeTree.clear();

            const uniqueNodes = new Map<
                number,
                { id: number; lng: number; lat: number }
            >();
            const edgeItems: EdgeIndexItem[] = [];

            // Stride is 12: [u, v, weight, hIn, hOut, isFerry, startIndex, pointCount]
            for (let i = 0; i < graphF32.length; i += 12) {
                const u = graphF32[i]!;
                const v = graphF32[i + 1]!;
                const weight = graphF32[i + 2];
                const hIn = graphF32[i + 3];
                const hOut = graphF32[i + 4];
                const isFerry = graphF32[i + 5];
                const requiredDlc = graphF32[i + 6];
                const vPrefabId = graphF32[i + 7];
                const startIndex = graphF32[i + 8]!;
                const pointCount = graphF32[i + 9]!;
                const maneuverType = graphF32[i + 10]!;
                const exitNumber = graphF32[i + 11]!;

                if (!adjacency.has(u)) adjacency.set(u, []);
                adjacency.get(u)!.push({
                    to: v,
                    weight: weight,
                    hIn: hIn,
                    hOut: hOut,
                    isFerry: isFerry,
                    requiredDlc: requiredDlc,
                    vPrefabId: vPrefabId,
                    startIndex,
                    pointCount,
                    maneuverType,
                    exitNumber,
                });

                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;

                for (let point = 0; point < pointCount; point++) {
                    const coordIndex = startIndex + point * 2;
                    const lng = geometryF32[coordIndex]!;
                    const lat = geometryF32[coordIndex + 1]!;
                    minX = Math.min(minX, lng);
                    minY = Math.min(minY, lat);
                    maxX = Math.max(maxX, lng);
                    maxY = Math.max(maxY, lat);
                }

                edgeItems.push({
                    minX,
                    minY,
                    maxX,
                    maxY,
                    fromId: u,
                    toId: v,
                    startIndex,
                    pointCount,
                });

                if (!uniqueNodes.has(u)) {
                    const lng = geometryF32[startIndex]!;
                    const lat = geometryF32[startIndex + 1]!;
                    uniqueNodes.set(u, { id: u, lng, lat });
                }

                if (!uniqueNodes.has(v)) {
                    const lastIdx = startIndex + (pointCount - 1) * 2;
                    const lng = geometryF32[lastIdx]!;
                    const lat = geometryF32[lastIdx + 1]!;
                    uniqueNodes.set(v, { id: v, lng, lat });
                }
            }

            rawNodesForWorker = Array.from(uniqueNodes.values()).map((n) => [
                n.id,
                [n.lng, n.lat],
            ]);

            const items: NodeIndexItem[] = [];
            for (const node of uniqueNodes.values()) {
                nodeCoords.set(node.id, [node.lng, node.lat]);
                items.push({
                    minX: node.lng,
                    minY: node.lat,
                    maxX: node.lng,
                    maxY: node.lat,
                    id: node.id,
                    coord: [node.lng, node.lat],
                });
            }

            nodeTree.load(items);
            edgeTree.load(edgeItems);

            progress.value = 100;
            await sleep(200);
        } catch (err) {
            console.error("Loading Graph Failed", err);
        } finally {
            clearInterval(ghostInterval);
            setTimeout(() => {
                loading.value = false;
            }, 500);
        }

        return {
            nodes: rawNodesForWorker,
            graphBuffer: workerGraphBuffer,
            geometryBuffer: workerGeometryBuffer,
        };
    };

    return {
        loading,
        progress,
        adjacency,
        nodeCoords,
        getClosestNodes,
        getClosestDestinationNodes,
        initializeGraphData,
    };
}
