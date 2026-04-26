mod routing;

use routing::{GraphData, RoutingEngine, RouteResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{UdpSocket, TcpListener};
use tokio::sync::{broadcast, RwLock};
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{error, info, warn};

/// WebSocket 请求协议结构
#[derive(Deserialize, Debug)]
#[serde(tag = "type", content = "payload")]
enum WsRequest {
    /// 路由计算请求
    #[serde(rename = "CALC_ROUTE")]
    CalcRoute(CalcRoutePayload),
}

/// 路由计算请求负载
#[derive(Deserialize, Debug)]
struct CalcRoutePayload {
    #[serde(rename = "startId")]
    start_id: usize,
    #[serde(rename = "possibleEnds")]
    possible_ends: Vec<usize>,
    heading: Option<f32>,
    #[serde(rename = "ownedDlcs")]
    owned_dlcs: Vec<i32>,
    #[serde(rename = "selectedGame")]
    selected_game: String, // "ets2" 或 "ats"
}

/// WebSocket 响应协议结构
#[derive(Serialize, Debug)]
#[serde(tag = "type", content = "payload")]
enum WsResponse {
    /// 路由计算结果
    #[serde(rename = "ROUTE_RESULT")]
    RouteResult(Option<RouteResult>),
    /// 实时遥感数据
    #[serde(rename = "TELEMETRY")]
    Telemetry(serde_json::Value),
}

/// 命令行参数
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// UDP 监听地址 (接收游戏数据)
    #[arg(long, default_value = "127.0.0.1:30002")]
    udp_addr: String,

    /// WebSocket 监听地址 (服务前端)
    #[arg(long, default_value = "0.0.0.0:30001")]
    ws_addr: String,

    /// 地图数据根目录
    #[arg(long, default_value = "../public/data")]
    data_dir: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 初始化日志系统
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    // 自动扫描并加载不同游戏的路由引擎
    let mut engines = HashMap::new();
    let data_path = std::path::Path::new(&args.data_dir);
    if data_path.exists() {
        for entry in std::fs::read_dir(data_path)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let game_name = path.file_name().unwrap().to_string_lossy().to_string();
                let road_network_path = path.join("roadnetwork");
                if road_network_path.exists() {
                    info!("正在加载 {} 的路由引擎...", game_name);
                    match GraphData::load(&road_network_path) {
                        Ok(data) => {
                            let engine = RoutingEngine::new(Arc::new(data));
                            engines.insert(game_name, Arc::new(engine));
                        }
                        Err(e) => error!("加载 {} 路网失败: {}", game_name, e),
                    }
                }
            }
        }
    } else {
        warn!("未发现数据目录: {}", args.data_dir);
    }

    let engines = Arc::new(engines);
    // 存储最后一次收到的遥感包，用于新连接快速同步
    let last_packet = Arc::new(RwLock::new(None::<String>));
    // 用于将数据包广播给所有连接的客户端
    let (tx, _rx) = broadcast::channel::<String>(100);

    // 启动 UDP 监听任务 (处理游戏发来的原始数据)
    let udp_socket: UdpSocket = UdpSocket::bind(&args.udp_addr).await?;
    info!("UDP 监听启动: {}", args.udp_addr);

    let last_packet_clone = Arc::clone(&last_packet);
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        let mut buf = [0u8; 65535];
        loop {
            match udp_socket.recv_from(&mut buf).await {
                Ok((len, _addr)) => {
                    let data = &buf[..len];
                    if let Ok(payload) = std::str::from_utf8(data) {
                        // 校验 JSON 合法性
                        if serde_json::from_str::<serde_json::Value>(payload).is_ok() {
                            let payload_str = payload.to_string();
                            
                            // 更新缓存
                            {
                                let mut last = last_packet_clone.write().await;
                                *last = Some(payload_str.clone());
                            }

                            // 广播给所有 WS 客户端
                            let _ = tx_clone.send(payload_str);
                        }
                    }
                }
                Err(e) => error!("UDP 接收错误: {}", e),
            }
        }
    });

    // 启动 WebSocket 服务器
    let listener: TcpListener = TcpListener::bind(&args.ws_addr).await?;
    info!("WebSocket 监听启动: {}", args.ws_addr);

    loop {
        let (stream, addr) = listener.accept().await?;
        let last_packet_clone = Arc::clone(&last_packet);
        let engines_clone = Arc::clone(&engines);
        let rx = tx.subscribe();

        // 为每个新连接创建独立任务
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr, last_packet_clone, engines_clone, rx).await {
                warn!("客户端连接处理中断 ({}): {}", addr, e);
            }
        });
    }
}

/// 处理具体的 WebSocket 连接
async fn handle_connection(
    stream: tokio::net::TcpStream,
    addr: SocketAddr,
    last_packet: Arc<RwLock<Option<String>>>,
    engines: Arc<HashMap<String, Arc<RoutingEngine>>>,
    mut rx: broadcast::Receiver<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws_stream = tokio_tungstenite::accept_async(stream).await?;
    info!("新客户端已连接: {}", addr);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // 建立连接后，立即发送最后缓存的遥感数据包
    {
        let last = last_packet.read().await;
        if let Some(ref packet) = *last {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(packet) {
                let resp = WsResponse::Telemetry(val);
                let json = serde_json::to_string(&resp)?;
                let _ = ws_sender.send(Message::Text(json.into())).await;
            }
        }
    }

    loop {
        tokio::select! {
            // 实时广播：从通道接收遥感包并转发
            msg = rx.recv() => {
                match msg {
                    Ok(packet) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&packet) {
                            let resp = WsResponse::Telemetry(val);
                            if let Ok(json) = serde_json::to_string(&resp) {
                                if ws_sender.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // 处理前端发送的计算请求
            ws_msg = ws_receiver.next() => {
                match ws_msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<WsRequest>(&text) {
                            Ok(req) => {
                                match req {
                                    WsRequest::CalcRoute(payload) => {
                                        info!("计算路由: {} 节点, 游戏: {}", payload.possible_ends.len(), payload.selected_game);
                                        let result = if let Some(engine) = engines.get(&payload.selected_game) {
                                            engine.calculate_route(
                                                payload.start_id,
                                                &payload.possible_ends,
                                                payload.heading,
                                                &payload.owned_dlcs
                                            )
                                        } else {
                                            warn!("未找到对应游戏的路由引擎: {}", payload.selected_game);
                                            None
                                        };
                                        
                                        let resp = WsResponse::RouteResult(result);
                                        if let Ok(json) = serde_json::to_string(&resp) {
                                            let _ = ws_sender.send(Message::Text(json.into())).await;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                error!("解析 WebSocket 请求失败: {}. 原始消息: {}", e, text);
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    Ok(())
}
