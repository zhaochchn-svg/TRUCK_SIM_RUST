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

#[derive(Deserialize, Debug)]
#[serde(tag = "type", content = "payload")]
enum WsRequest {
    #[serde(rename = "CALC_ROUTE")]
    CalcRoute(CalcRoutePayload),
}

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
    selected_game: String, // "ets2" or "ats"
}

#[derive(Serialize, Debug)]
#[serde(tag = "type", content = "payload")]
enum WsResponse {
    #[serde(rename = "ROUTE_RESULT")]
    RouteResult(Option<RouteResult>),
    #[serde(rename = "TELEMETRY")]
    Telemetry(serde_json::Value),
}
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:30002")]
    udp_addr: String,

    #[arg(long, default_value = "0.0.0.0:30001")]
    ws_addr: String,

    #[arg(long, default_value = "../TruckNav-Sim/public/data")]
    data_dir: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    // Load Engines
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
                    info!("Loading routing engine for {}", game_name);
                    match GraphData::load(&road_network_path) {
                        Ok(data) => {
                            let engine = RoutingEngine::new(Arc::new(data));
                            engines.insert(game_name, Arc::new(engine));
                        }
                        Err(e) => error!("Failed to load graph for {}: {}", game_name, e),
                    }
                }
            }
        }
    } else {
        warn!("Data directory not found at {}", args.data_dir);
    }

    let engines = Arc::new(engines);
    let last_packet = Arc::new(RwLock::new(None::<String>));
    let (tx, _rx) = broadcast::channel::<String>(100);

    // UDP Listener Task
    let udp_socket: UdpSocket = UdpSocket::bind(&args.udp_addr).await?;
    info!("UDP listening on {}", args.udp_addr);

    let last_packet_clone = Arc::clone(&last_packet);
    let tx_clone = tx.clone();

    tokio::spawn(async move {
        let mut buf = [0u8; 65535];
        loop {
            match udp_socket.recv_from(&mut buf).await {
                Ok((len, _addr)) => {
                    let data = &buf[..len];
                    if let Ok(payload) = std::str::from_utf8(data) {
                        // Basic JSON validation
                        if serde_json::from_str::<serde_json::Value>(payload).is_ok() {
                            let payload_str = payload.to_string();
                            
                            // Update last packet
                            {
                                let mut last = last_packet_clone.write().await;
                                *last = Some(payload_str.clone());
                            }

                            // Broadcast to all WS clients
                            let _ = tx_clone.send(payload_str);
                        }
                    }
                }
                Err(e) => {
                    error!("UDP receive error: {}", e);
                }
            }
        }
    });

    // WebSocket Server
    let listener: TcpListener = TcpListener::bind(&args.ws_addr).await?;
    info!("WS listening on {}", args.ws_addr);

    loop {
        let (stream, addr) = listener.accept().await?;
        let last_packet_clone = Arc::clone(&last_packet);
        let engines_clone = Arc::clone(&engines);
        let rx = tx.subscribe();

        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr, last_packet_clone, engines_clone, rx).await {
                warn!("Error handling connection from {}: {}", addr, e);
            }
        });
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    addr: SocketAddr,
    last_packet: Arc<RwLock<Option<String>>>,
    engines: Arc<HashMap<String, Arc<RoutingEngine>>>,
    mut rx: broadcast::Receiver<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws_stream = tokio_tungstenite::accept_async(stream).await?;
    info!("New WebSocket connection: {}", addr);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Send the last packet immediately upon connection
    {
        let last = last_packet.read().await;
        if let Some(ref packet) = *last {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(packet) {
                let resp = WsResponse::Telemetry(val);
                let json = serde_json::to_string(&resp)?;
                if let Err(e) = ws_sender.send(Message::Text(json.into())).await {
                    error!("Failed to send initial packet to {}: {}", addr, e);
                    return Ok(());
                }
            }
        }
    }

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(packet) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&packet) {
                            let resp = WsResponse::Telemetry(val);
                            if let Ok(json) = serde_json::to_string(&resp) {
                                if let Err(_) = ws_sender.send(Message::Text(json.into())).await {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            ws_msg = ws_receiver.next() => {
                match ws_msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(req) = serde_json::from_str::<WsRequest>(&text) {
                            match req {
                                WsRequest::CalcRoute(payload) => {
                                    info!("Calculating route for {} nodes from {} in {}", payload.possible_ends.len(), payload.start_id, payload.selected_game);
                                    let result = if let Some(engine) = engines.get(&payload.selected_game) {
                                        engine.calculate_route(
                                            payload.start_id,
                                            &payload.possible_ends,
                                            payload.heading,
                                            &payload.owned_dlcs
                                        )
                                    } else {
                                        warn!("Engine not found for {}", payload.selected_game);
                                        None
                                    };
                                    
                                    let resp = WsResponse::RouteResult(result);
                                    if let Ok(json) = serde_json::to_string(&resp) {
                                        let _ = ws_sender.send(Message::Text(json.into())).await;
                                    }
                                }
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
