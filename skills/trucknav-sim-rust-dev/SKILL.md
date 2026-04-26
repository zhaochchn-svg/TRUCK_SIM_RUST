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

## Verification Preference

- Default to fast syntax/type validation after edits.
- Do not wait for a full frontend production build after every change unless the user explicitly asks for it or a syntax/type check is not enough to validate the edit.
- For this repo, `npx tsc -p tsconfig.json --noEmit` is the preferred quick validation step for frontend changes.

## Units And Telemetry Invariants

- Keep internal route, navigation, and telemetry calculations in the units reported by the game/SDK or in one explicit canonical unit chosen by the module. Do not infer units from the UI language.
- Read unit-related settings from the game telemetry/settings when they affect calculation semantics. Display components may convert to user-facing fixed units, but calculation inputs must not be pre-converted for presentation.
- Treat speed, distance, and time as separate quantities. Do not reuse distance conversion helpers for speed, and do not derive ETA from already-rounded display distance.
- For route summaries, calculate remaining distance/time from raw route progress and raw speed values, then convert only at the final display boundary.
- When adding new HUD or sheet values, name variables with their canonical unit suffix where practical, such as `speedKph`, `distanceKm`, `durationHours`, or `distanceMeters`.
- Road graph edge weights in `graph.bin` are meters. The Rust `RouteResult.node_kms` WebSocket field must be converted to kilometers before it leaves the backend, because frontend route summaries and maneuver distances treat it as kilometers.
