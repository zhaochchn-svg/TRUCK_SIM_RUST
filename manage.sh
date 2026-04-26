#!/bin/bash

# TruckNav-Sim 全自动一键管理脚本

case "$1" in
  start)
    echo "======================================"
    echo "🚀 正在全自动启动 TruckNav (Rust + Nuxt)..."
    echo "======================================"
    
    # 1. 检查 Node.js 依赖
    if [ ! -d "node_modules" ]; then
        echo "📦 未发现 node_modules，正在安装依赖..."
        # 尝试使用国内镜像加速
        if command -v npm &> /dev/null; then
            npm install --registry=https://registry.npmmirror.com
        else
            echo "❌ 错误: 未发现 npm，请先安装 Node.js"
            exit 1
        fi
    fi

    # 2. 强制清理残留进程，防止端口占用
    echo "🧹 清理旧进程..."
    killall trucknav-sim-rust 2>/dev/null
    
    # 3. 编译 Rust 后端 (Cargo 会自动处理增量编译)
    echo "📦 正在检查并编译 Rust 后端..."
    if command -v cargo &> /dev/null; then
        npm run rust:build
    else
        echo "❌ 错误: 未发现 cargo，请先安装 Rust"
        exit 1
    fi
    
    # 4. 启动开发服务器
    echo "✨ 启动 Nuxt 前端..."
    npm run dev
    ;;
    
  stop)
    echo "======================================"
    echo "🛑 正在关闭所有相关进程..."
    echo "======================================"
    
    # 杀掉 Rust 后端
    killall trucknav-sim-rust 2>/dev/null
    
    # 杀掉 Nuxt 开发服务器
    pkill -f "nuxt dev" 2>/dev/null
    
    echo "✅ 已彻底关闭。"
    ;;

  *)
    echo "使用方法: ./manage.sh {start|stop}"
    exit 1
    ;;
esac
