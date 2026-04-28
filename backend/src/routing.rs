use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

#[derive(Copy, Clone, PartialEq)]
struct State {
    cost: f32,
    edge_id: usize,
}

impl Eq for State {}

impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
    }
}

impl PartialOrd for State {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RouteResult {
    pub path: Vec<[f32; 2]>,
    pub node_sequence: Vec<usize>,
    pub sequence_maneuvers: Vec<i8>,
    pub sequence_exits: Vec<i8>,
    pub node_kms: Vec<f32>,
    pub node_hours: Vec<f32>,
}

const GRAPH_STRIDE: usize = 12;

pub struct GraphData {
    pub graph_mmap: Mmap,
    pub geometry_mmap: Mmap,
}

impl GraphData {
    pub fn load<P: AsRef<Path>>(dir: P) -> Result<Self, Box<dyn std::error::Error>> {
        let graph_path = dir.as_ref().join("graph.bin");
        let geom_path = dir.as_ref().join("geometry.bin");
        let graph_file = File::open(graph_path)?;
        let geom_file = File::open(geom_path)?;
        let graph_mmap = unsafe { Mmap::map(&graph_file)? };
        let geometry_mmap = unsafe { Mmap::map(&geom_file)? };
        let data = Self {
            graph_mmap,
            geometry_mmap,
        };
        data.validate()?;
        Ok(data)
    }

    pub fn get_graph_f32(&self) -> &[f32] {
        let ptr = self.graph_mmap.as_ptr() as *const f32;
        let len = self.graph_mmap.len() / 4;
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }

    pub fn get_geometry_f32(&self) -> &[f32] {
        let ptr = self.geometry_mmap.as_ptr() as *const f32;
        let len = self.geometry_mmap.len() / 4;
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }

    fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        if !self.graph_mmap.len().is_multiple_of(GRAPH_STRIDE * 4) {
            return Err(format!(
                "graph.bin length {} is not aligned to stride {}",
                self.graph_mmap.len(),
                GRAPH_STRIDE
            )
            .into());
        }

        if !self.geometry_mmap.len().is_multiple_of(8) {
            return Err(format!(
                "geometry.bin length {} is not aligned to lng/lat pairs",
                self.geometry_mmap.len()
            )
            .into());
        }

        let graph_f32 = self.get_graph_f32();
        let geom_len = self.get_geometry_f32().len();

        for edge_start in (0..graph_f32.len()).step_by(GRAPH_STRIDE) {
            let edge_id = edge_start / GRAPH_STRIDE;
            let edge = &graph_f32[edge_start..edge_start + GRAPH_STRIDE];
            if edge.iter().any(|value| !value.is_finite()) {
                return Err(format!("graph.bin edge {edge_id} contains non-finite values").into());
            }

            if edge[0] < 0.0 || edge[1] < 0.0 {
                return Err(format!("graph.bin edge {edge_id} contains negative node ids").into());
            }

            if edge[2] <= 0.0 {
                return Err(format!("graph.bin edge {edge_id} has non-positive weight").into());
            }

            let start_pt_idx = edge[8] as usize;
            let point_count = edge[9] as usize;
            if point_count == 0 {
                return Err(format!("graph.bin edge {edge_id} has empty geometry").into());
            }

            let geom_end = start_pt_idx
                .checked_add(point_count.saturating_mul(2))
                .ok_or_else(|| format!("graph.bin edge {edge_id} geometry index overflows"))?;
            if geom_end > geom_len {
                return Err(
                    format!("graph.bin edge {edge_id} references geometry out of bounds").into(),
                );
            }
        }

        Ok(())
    }
}

pub struct RoutingEngine {
    data: Arc<GraphData>,
    adjacency: Vec<Vec<usize>>,
}

impl RoutingEngine {
    pub fn new(data: Arc<GraphData>) -> Self {
        let graph_f32 = data.get_graph_f32();
        let mut max_node_id = 0;
        for i in (0..graph_f32.len()).step_by(GRAPH_STRIDE) {
            let u = graph_f32[i] as usize;
            let v = graph_f32[i + 1] as usize;
            max_node_id = max_node_id.max(u).max(v);
        }
        let mut adjacency = vec![Vec::new(); max_node_id + 1];
        for i in (0..graph_f32.len()).step_by(GRAPH_STRIDE) {
            let u = graph_f32[i] as usize;
            let edge_idx = i / GRAPH_STRIDE;
            adjacency[u].push(edge_idx);
        }
        Self { data, adjacency }
    }

    fn edge_speed_kph(distance_meters: f32, is_ferry: bool, maneuver_type: i32) -> f32 {
        if is_ferry {
            return 45.0;
        }

        if maneuver_type == 3 {
            return 35.0;
        }

        if distance_meters >= 3_000.0 {
            95.0
        } else if distance_meters >= 1_200.0 {
            85.0
        } else if distance_meters >= 500.0 {
            65.0
        } else if distance_meters >= 150.0 {
            45.0
        } else {
            30.0
        }
    }

    fn edge_travel_seconds(graph_f32: &[f32], stride_idx: usize) -> f32 {
        let distance_meters = graph_f32[stride_idx + 2].max(1.0);
        let is_ferry = graph_f32[stride_idx + 5] > 0.5;
        let maneuver_type = graph_f32[stride_idx + 10] as i32;
        let speed_kph = Self::edge_speed_kph(distance_meters, is_ferry, maneuver_type);
        let mut seconds = distance_meters / (speed_kph / 3.6);

        if is_ferry {
            seconds += 300.0;
        }

        seconds.max(1.0)
    }

    fn signal_or_intersection_delay_seconds(graph_f32: &[f32], stride_idx: usize) -> f32 {
        // Current graph data has no explicit signal flag, so short junction edges and maneuver types proxy red-light/stop waits.
        let distance_meters = graph_f32[stride_idx + 2].max(1.0);
        let is_ferry = graph_f32[stride_idx + 5] > 0.5;
        let maneuver_type = graph_f32[stride_idx + 10] as i32;

        if is_ferry {
            return 0.0;
        }

        match maneuver_type {
            1 | 2 => 12.0,
            3 => 6.0,
            5 => 6.0,
            6 | 7 => 8.0,
            _ if distance_meters < 80.0 => 4.0,
            _ => 0.0,
        }
    }

    fn angle_diff_radians(a: f32, b: f32) -> f32 {
        let mut diff = (a - b).abs();
        if diff > std::f32::consts::PI {
            diff = 2.0 * std::f32::consts::PI - diff;
        }
        diff
    }

    fn routing_turn_penalty_seconds(
        graph_f32: &[f32],
        previous_edge_id: Option<usize>,
        next_stride_idx: usize,
    ) -> f32 {
        let Some(previous_edge_id) = previous_edge_id else {
            return 0.0;
        };

        if graph_f32[next_stride_idx + 5] > 0.5 {
            return 0.0;
        }

        let previous_h_in = graph_f32[previous_edge_id * GRAPH_STRIDE + 3];
        let next_h_out = graph_f32[next_stride_idx + 4];
        let diff = Self::angle_diff_radians(previous_h_in, next_h_out);
        let maneuver_type = graph_f32[next_stride_idx + 10] as i32;

        if maneuver_type == 3 {
            if diff > 1.0 {
                25.0
            } else {
                0.0
            }
        } else if diff > 2.8 {
            1_800.0
        } else if diff > 1.5 {
            240.0
        } else if diff > 1.0 {
            90.0
        } else if diff > 0.4 {
            20.0
        } else {
            0.0
        }
    }

    fn eta_turn_delay_seconds(
        graph_f32: &[f32],
        previous_edge_id: Option<usize>,
        next_edge_id: usize,
    ) -> f32 {
        let Some(previous_edge_id) = previous_edge_id else {
            return 0.0;
        };

        let next_stride_idx = next_edge_id * GRAPH_STRIDE;
        if graph_f32[next_stride_idx + 5] > 0.5 {
            return 0.0;
        }

        let previous_h_in = graph_f32[previous_edge_id * GRAPH_STRIDE + 3];
        let next_h_out = graph_f32[next_stride_idx + 4];
        let diff = Self::angle_diff_radians(previous_h_in, next_h_out);
        let maneuver_type = graph_f32[next_stride_idx + 10] as i32;

        if maneuver_type == 3 {
            8.0
        } else if diff > 2.8 {
            45.0
        } else if diff > 1.5 {
            25.0
        } else if diff > 1.0 {
            12.0
        } else if diff > 0.4 {
            5.0
        } else {
            0.0
        }
    }

    fn routing_step_cost_seconds(
        graph_f32: &[f32],
        previous_edge_id: Option<usize>,
        next_stride_idx: usize,
    ) -> f32 {
        Self::edge_travel_seconds(graph_f32, next_stride_idx)
            + Self::signal_or_intersection_delay_seconds(graph_f32, next_stride_idx)
            + Self::routing_turn_penalty_seconds(graph_f32, previous_edge_id, next_stride_idx)
    }

    fn eta_step_seconds(
        graph_f32: &[f32],
        previous_edge_id: Option<usize>,
        next_edge_id: usize,
    ) -> f32 {
        let stride_idx = next_edge_id * GRAPH_STRIDE;
        Self::edge_travel_seconds(graph_f32, stride_idx)
            + Self::signal_or_intersection_delay_seconds(graph_f32, stride_idx)
            + Self::eta_turn_delay_seconds(graph_f32, previous_edge_id, next_edge_id)
    }

    pub fn calculate_route(
        &self,
        start_node: usize,
        possible_ends: &[usize],
        _start_heading: Option<f32>,
        owned_dlcs: &[i32],
    ) -> Option<RouteResult> {
        // 健壮性检查: 无目的地则直接返回
        if possible_ends.is_empty() {
            return None;
        }

        let graph_f32 = self.data.get_graph_f32();
        let num_edges = graph_f32.len() / GRAPH_STRIDE;
        if start_node >= self.adjacency.len() {
            return None;
        }
        let start_edge_fake_id = num_edges;

        let mut costs = vec![f32::INFINITY; num_edges + 1];
        let mut previous = vec![None; num_edges + 1];
        let mut heap = BinaryHeap::new();

        costs[start_edge_fake_id] = 0.0;
        heap.push(State {
            cost: 0.0,
            edge_id: start_edge_fake_id,
        });

        let mut found_end_edge = None;
        let ends_set: std::collections::HashSet<usize> = possible_ends.iter().cloned().collect();

        // Dijkstra 主循环
        while let Some(State { cost, edge_id }) = heap.pop() {
            if cost > costs[edge_id] {
                continue;
            }
            let current_node = if edge_id == start_edge_fake_id {
                start_node
            } else {
                graph_f32[edge_id * GRAPH_STRIDE + 1] as usize
            };
            if ends_set.contains(&current_node) {
                found_end_edge = Some(edge_id);
                break;
            }
            let previous_edge_id = if edge_id == start_edge_fake_id {
                None
            } else {
                Some(edge_id)
            };

            if current_node >= self.adjacency.len() {
                continue;
            }

            for &next_edge_idx in &self.adjacency[current_node] {
                let stride_idx = next_edge_idx * GRAPH_STRIDE;
                let req_dlc = graph_f32[stride_idx + 6] as i32;
                if req_dlc != 0 && !owned_dlcs.contains(&req_dlc) {
                    continue;
                }

                let step_cost =
                    Self::routing_step_cost_seconds(graph_f32, previous_edge_id, stride_idx);

                let next_cost = cost + step_cost;
                if next_cost < costs[next_edge_idx] {
                    costs[next_edge_idx] = next_cost;
                    previous[next_edge_idx] = Some(edge_id);
                    heap.push(State {
                        cost: next_cost,
                        edge_id: next_edge_idx,
                    });
                }
            }
        }

        let end_edge_id = found_end_edge?;
        let mut path = Vec::new();
        let mut node_sequence = Vec::new();
        let mut sequence_maneuvers = Vec::new();
        let mut sequence_exits = Vec::new();
        let mut edge_weights = Vec::new();
        let mut edge_ids = Vec::new();

        let mut curr_edge = end_edge_id;
        let geom_f32 = self.data.get_geometry_f32();

        // 路径回溯 (增加长度保护防止死循环)
        let mut loop_guard = 0;
        let max_hops = num_edges;

        while curr_edge != start_edge_fake_id {
            if loop_guard > max_hops {
                break;
            }
            loop_guard += 1;

            let stride_idx = curr_edge * GRAPH_STRIDE;
            node_sequence.insert(0, graph_f32[stride_idx + 1] as usize);
            sequence_maneuvers.insert(0, graph_f32[stride_idx + 10] as i8);
            sequence_exits.insert(0, graph_f32[stride_idx + 11] as i8);
            edge_weights.insert(0, graph_f32[stride_idx + 2]);
            edge_ids.insert(0, curr_edge);

            let start_pt_idx = graph_f32[stride_idx + 8] as usize;
            let pt_count = graph_f32[stride_idx + 9] as usize;
            for p in (0..pt_count).rev() {
                path.insert(
                    0,
                    [
                        geom_f32[start_pt_idx + p * 2],
                        geom_f32[start_pt_idx + p * 2 + 1],
                    ],
                );
            }

            match previous[curr_edge] {
                Some(prev) => curr_edge = prev,
                None => break,
            }
        }

        node_sequence.insert(0, start_node);
        sequence_maneuvers.insert(0, 0);
        sequence_exits.insert(0, 0);

        let mut node_kms = Vec::with_capacity(node_sequence.len());
        let mut node_hours = Vec::with_capacity(node_sequence.len());
        let mut total_meters = 0.0;
        let mut total_seconds = 0.0;
        node_kms.push(0.0);
        node_hours.push(0.0);

        let mut previous_edge_id = None;
        for (idx, edge_id) in edge_ids.iter().enumerate() {
            let w = edge_weights[idx];
            total_meters += w;
            total_seconds += Self::eta_step_seconds(graph_f32, previous_edge_id, *edge_id);
            node_kms.push(total_meters / 1000.0);
            node_hours.push(total_seconds / 3600.0);
            previous_edge_id = Some(*edge_id);
        }

        Some(RouteResult {
            path,
            node_sequence,
            sequence_maneuvers,
            sequence_exits,
            node_kms,
            node_hours,
        })
    }
}
