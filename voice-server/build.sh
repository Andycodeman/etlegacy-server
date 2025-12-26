#!/bin/bash
# Build the voice server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

echo "Building ET:Legacy Voice Server..."

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

cmake ..
make -j$(nproc)

echo ""
echo "Build complete!"
echo "Binary: $BUILD_DIR/voice_server"
echo ""
echo "Usage: ./voice_server [port] [game_port]"
echo "  Default: port 27961, game_port 27960"
