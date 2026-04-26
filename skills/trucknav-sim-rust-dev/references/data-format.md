# Road Network Data Format

## graph.bin

The graph file is a `Float32Array` of edges. Each edge follows a **Stride of 12**.

| Index | Field | Description |
|---|---|---|
| 0 | `u` | Start Node ID |
| 1 | `v` | End Node ID |
| 2 | `weight` | Distance in meters |
| 3 | `hIn` | Arrival heading (radians) |
| 4 | `hOut` | Departure heading (radians) |
| 5 | `isFerry` | 1.0 if ferry, 0.0 otherwise |
| 6 | `dlc` | Required DLC ID (Integer) |
| 7 | `prefab` | Prefab ID (Integer) |
| 8 | `startIdx` | Pointer to start of geometry in `geometry.bin` |
| 9 | `pointCount` | Number of [lng, lat] pairs in `geometry.bin` |
| 10 | `maneuver` | Maneuver type ID |
| 11 | `exit` | Roundabout exit number |

## geometry.bin

A continuous `Float32Array` of `[longitude, latitude]` pairs. 
Edges in `graph.bin` point into this array using `startIdx` and `pointCount`.
Total coordinate pairs for an edge: `pointCount * 2`.
