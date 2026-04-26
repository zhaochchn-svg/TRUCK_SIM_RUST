---
name: trucknav-sim-rust-dev
description: Specialized knowledge for the TruckNav-Sim Rust backend and Nuxt frontend integration. Use when working on the Telemetry Bridge, Routing Engine, or data-driven features of the TruckNav-Sim project.
---

# TruckNav-Sim Rust Development

## Project Overview

This project is a high-performance rewrite of the TruckNav-Sim backend using Rust, integrated with a Nuxt.js frontend.

## Architecture

- **Backend (Rust)**: Located in `src/`. Single process handling UDP telemetry (from game) and WebSocket communication (to frontend).
- **Frontend (Nuxt)**: Located in `app/`. Communicates with Rust via WebSocket.
- **Data**: Binary road network files located in `public/data/<game>/roadnetwork/`.

## Backend Binary Protocol

### UDP Telemetry (Inbound)
- **Port**: `127.0.0.1:30002`
- **Format**: JSON packets from the SCS Telemetry Plugin.

### WebSocket (Bi-directional)
- **Port**: `0.0.0.0:30001`
- **Protocol**: `WsResponse` (Outbound) and `WsRequest` (Inbound).
  - `TELEMETRY`: Real-time game data.
  - `CALC_ROUTE`: Route calculation request.
  - `ROUTE_RESULT`: Calculation output.

## Road Network Data Format

For detailed binary structure of `graph.bin` and `geometry.bin`, refer to [references/data-format.md](references/data-format.md).

## Common Workflows

### Rebuilding Backend
```bash
cargo build --release
```

### Adding Routing Features
1. Modify `src/routing.rs` for algorithm logic.
2. Update `src/main.rs` if JSON protocol changes.
3. Update `app/composables/RouteController.ts` for frontend handling.
