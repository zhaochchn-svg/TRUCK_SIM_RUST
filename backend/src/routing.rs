use memmap2::Mmap;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::collections::BinaryHeap;
use std::cmp::Ordering;
use serde::{Serialize, Deserialize};

#[derive(Copy, Clone, PartialEq)]
struct State {
    cost: f32,
    edge_id: usize, // We use edge-based Dijkstra to handle turn penalties
}

impl Eq for State {}

impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        other.cost.partial_cmp(&self.cost).unwrap_or(Ordering::Equal)
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
}

// Stride 12 from packer.ts: [u, v, weight, hIn, hOut, isFerry, dlc, prefab, startIdx, pointCount, maneuver, exit]
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

        Ok(Self {
            graph_mmap,
            geometry_mmap,
        })
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
}

pub struct RoutingEngine {
    data: Arc<GraphData>,
    // Adjacency list: Map<node_id, Vec<edge_index>>
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

        Self {
            data,
            adjacency,
        }
    }

    pub fn calculate_route(
        &self,
        start_node: usize,
        possible_ends: &[usize],
        _start_heading: Option<f32>,
        owned_dlcs: &[i32],
    ) -> Option<RouteResult> {
        let graph_f32 = self.data.get_graph_f32();
        let num_edges = graph_f32.len() / GRAPH_STRIDE;
        let start_edge_fake_id = num_edges;

        let mut costs = vec![f32::INFINITY; num_edges + 1];
        let mut previous = vec![None; num_edges + 1];
        let mut heap = BinaryHeap::new();

        costs[start_edge_fake_id] = 0.0;
        heap.push(State { cost: 0.0, edge_id: start_edge_fake_id });

        let mut found_end_edge = None;
        let ends_set: std::collections::HashSet<usize> = possible_ends.iter().cloned().collect();

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

            let current_h_in = if edge_id == start_edge_fake_id {
                0.0
            } else {
                graph_f32[edge_id * GRAPH_STRIDE + 3]
            };

            for &next_edge_idx in &self.adjacency[current_node] {
                let stride_idx = next_edge_idx * GRAPH_STRIDE;
                
                let req_dlc = graph_f32[stride_idx + 6] as i32;
                if req_dlc != 0 && !owned_dlcs.contains(&req_dlc) {
                    continue;
                }

                let weight = graph_f32[stride_idx + 2];
                let h_out = graph_f32[stride_idx + 4];
                let is_ferry = graph_f32[stride_idx + 5] > 0.5;

                let mut step_cost = weight;

                if !is_ferry {
                    if edge_id != start_edge_fake_id {
                        let mut diff = (current_h_in - h_out).abs();
                        if diff > std::f32::consts::PI {
                            diff = 2.0 * std::f32::consts::PI - diff;
                        }

                        let maneuver_type = graph_f32[stride_idx + 10] as i32;
                        if maneuver_type == 3 {
                             if diff > 1.0 { step_cost += 50.0; }
                        } else {
                            if diff > 2.8 { step_cost += 100_000.0; }
                            else if diff > 1.5 { step_cost += 10_000.0; }
                            else if diff > 1.0 { step_cost += 1000.0; }
                            else if diff > 0.4 { step_cost += 500.0; }
                        }
                    }
                }

                let next_cost = cost + step_cost;
                if next_cost < costs[next_edge_idx] {
                    costs[next_edge_idx] = next_cost;
                    previous[next_edge_idx] = Some(edge_id);
                    heap.push(State { cost: next_cost, edge_id: next_edge_idx });
                }
            }
        }

        let end_edge_id = found_end_edge?;
        let mut path = Vec::new();
        let mut node_sequence = Vec::new();
        let mut curr_edge = end_edge_id;

        let geom_f32 = self.data.get_geometry_f32();

        while curr_edge != start_edge_fake_id {
            let stride_idx = curr_edge * GRAPH_STRIDE;
            let target_node = graph_f32[stride_idx + 1] as usize;
            node_sequence.insert(0, target_node);

            let start_pt_idx = graph_f32[stride_idx + 8] as usize;
            let pt_count = graph_f32[stride_idx + 9] as usize;
            
            for p in (0..pt_count).rev() {
                let lng = geom_f32[start_pt_idx + p * 2];
                let lat = geom_f32[start_pt_idx + p * 2 + 1];
                path.insert(0, [lng, lat]);
            }

            curr_edge = previous[curr_edge]?;
        }

        node_sequence.insert(0, start_node);
        Some(RouteResult { path, node_sequence })
    }
}
