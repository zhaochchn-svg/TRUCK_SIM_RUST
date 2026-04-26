# TruckNav macOS telemetry plugin

This plugin is loaded by the macOS Steam builds of ETS2/ATS through the SCS
Telemetry SDK. It sends telemetry packets to the local TruckNav bridge over UDP
on `127.0.0.1:30002`. The bridge republishes the same payloads to the existing
frontend WebSocket on `ws://127.0.0.1:30001`.

Build:

```bash
npm run telemetry:build:mac
```

Output:

```text
electron/bin/darwin-x64/scs-trucknav.so
```

The Steam macOS builds currently ship x86_64 game binaries, so the plugin is
compiled with `-arch x86_64`.
