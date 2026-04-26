export interface DirectionStep {
    id: number;
    type:
        | "depart"
        | "straight"
        | "left"
        | "right"
        | "slight-left"
        | "slight-right"
        | "sharp-left"
        | "sharp-right"
        | "ferry"
        | "roundabout"
        | "destination"
        | "exit-highway";
    text: string;
    distance: number;
    coords: [number, number];
    exitCoords?: [number, number];
    debugAngle?: number;
    debugPrefabId?: number;
    exitCount?: number;
    cumulativeKm?: number;
    exitCumulativeKm?: number;
}

export function generateDirectionsList(
    nodeSequence: number[],
    nodeKms: Float32Array,
    sequenceManeuvers: Int8Array,
    sequenceExits: Int8Array,
    nodeCoords: Map<number, [number, number]>,
): DirectionStep[] {
    const steps: DirectionStep[] = [];
    if (nodeSequence.length < 2) return steps;

    steps.push({
        id: 0,
        type: "depart",
        text: "开始导航",
        distance: 0,
        coords: nodeCoords.get(nodeSequence[0]!) || [0, 0],
    });

    let lastStepKm = 0;
    let inRoundabout = false;

    for (let i = 0; i < nodeSequence.length - 1; i++) {
        const curr = nodeSequence[i];
        const next = nodeSequence[i + 1];
        const maneuver = sequenceManeuvers[i]!;

        if (maneuver === 3) {
            if (inRoundabout) continue;
            inRoundabout = true;
        } else {
            inRoundabout = false;
        }

        if (maneuver > 0 && maneuver !== 4) {
            let turnType: DirectionStep["type"] = "straight";
            let turnText = "";
            let exitCount = sequenceExits[i]!;

            switch (maneuver) {
                case 1:
                    turnType = "left";
                    turnText = "左转";
                    break;
                case 2:
                    turnType = "right";
                    turnText = "右转";
                    break;
                case 3: {
                    turnType = "roundabout";
                    if (exitCount && exitCount > 0) {
                        turnText = `从第${exitCount}出口驶出`;
                    } else {
                        turnText = `进入环岛`;
                    }
                    break;
                }
                case 5:
                    turnType = "exit-highway";
                    turnText = "从出口驶出";
                    break;
                case 6:
                    turnType = "slight-left";
                    turnText = "靠左行驶";
                    break;
                case 7:
                    turnType = "slight-right";
                    turnText = "靠右行驶";
                    break;
            }

            if (turnText !== "") {
                steps[steps.length - 1]!.distance = nodeKms[i]! - lastStepKm;
                steps.push({
                    id: curr!,
                    type: turnType,
                    text: turnText,
                    distance: 0,
                    cumulativeKm: nodeKms[i],
                    exitCumulativeKm: nodeKms[i + 1],
                    coords: nodeCoords.get(curr!) || [0, 0],
                    exitCoords: next !== undefined ? (nodeCoords.get(next!) || [0, 0]) : (nodeCoords.get(curr!) || [0, 0]),
                    exitCount: exitCount,
                });
                lastStepKm = nodeKms[i]!;
            }
        }
    }

    // Add Destination
    const totalKm = nodeKms[nodeSequence.length - 1];
    steps[steps.length - 1]!.distance = Math.max(0, totalKm! - lastStepKm);
    steps.push({
        id: nodeSequence[nodeSequence.length - 1]!,
        type: "destination",
        text: "已到达目的地",
        distance: 0,
        coords: nodeCoords.get(nodeSequence[nodeSequence.length - 1]!) || [
            0, 0,
        ],
    });

    return steps;
}
