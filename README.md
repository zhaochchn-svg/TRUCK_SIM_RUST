# TruckNav-Sim Rust 优化版

本项目是 [TruckNav-Sim](https://github.com/munteanrares/TruckNav-Sim) 的高性能重构版本。通过引入 **Rust** 作为核心计算后端，大幅提升了路网处理速度、降低了浏览器内存占用，并原生支持 macOS 等多平台的高效运行。

## 🚀 核心优化

-   **高性能 Rust 后端**: 路由计算与数据中转完全由 Rust 驱动，替代了原有的 Node.js 桥接和前端 Web Worker。
-   **内存映射 (Memory Mapping)**: 利用 `mmap` 技术按需读取数百万条路网边数据。应用启动速度提升至毫秒级，且无需在内存中常驻几百 MB 的地图文件。
-   **原生 A* 寻路**: 移植并优化了 A* 路由算法，支持边基 (Edge-based) 搜索和精确的航向角转向惩罚。
-   **统一 WebSocket 协议**: 单个连接即可同时处理高频遥感数据广播与复杂的路由请求。
-   **多端联动**: 原生支持局域网 IP 自动识别，方便手机、平板等设备一键连接。

## 🛠️ 项目结构

-   `/backend`: Rust 源代码，负责高性能计算与 Telemetry 数据转发。
-   `/app`: Nuxt.js 前端代码，负责 UI 渲染与地图交互。
-   `/public/data`: 存放 ETS2/ATS 的二进制路网数据 (`graph.bin`, `geometry.bin`)。
-   `/server`: Nuxt Nitro 插件，用于在应用启动时自动管理 Rust 进程。

## 🚦 快速开始

### 前提条件
-   安装 [Rust](https://www.rust-lang.org/) (推荐最新稳定版)
-   安装 [Node.js](https://nodejs.org/) (v18+)
-   确保游戏已安装 [SCS Telemetry 插件](https://github.com/Rencloud/scs-sdk-plugin)

### 1. 编译并启动
在项目根目录下执行以下命令：

```bash
# 编译 Rust 后端 (仅需执行一次)
npm run rust:build

# 一键启动 (自动清理旧进程并运行)
npm start
```

### 2. 多端连接
启动后，控制台会打印出如下信息：
```text
==================================================
🚀 TruckNav is ready for other devices!
📱 Web URL: http://192.168.x.x:3000
🔌 WebSocket: ws://192.168.x.x:30001
==================================================
```
使用您的手机或平板访问 **Web URL** 即可开始导航。

## 🕹️ 使用技巧

-   **返回主页**: 点击地图上的返回图标可回到游戏选择页面。应用会自动记住您的上次选择，下次进入时将直接跳转地图。
-   **清理缓存**: 如果需要彻底重置所有设置（包括持久化的游戏选择），点击游戏选择页面底部的“清除所有缓存与设置”。
-   **彻底关闭**: 如果需要停止项目，在终端按下 `Ctrl + C`，或运行 `npm stop` 强制清理残留进程。

## 📄 开源协议
本项目基于 MIT 协议开源。
