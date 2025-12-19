#!/bin/bash
#
# ET:Legacy Server - Local Deploy Script
# Deploys built binaries and configs to local server directory
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"
SERVER_DIR="$HOME/etlegacy"
LEGACY_DIR="$SERVER_DIR/legacy"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  ET:Legacy Server Deploy${NC}"
echo -e "${GREEN}================================${NC}"

# Check if build exists
if [ ! -d "$BUILD_DIR" ]; then
    echo -e "${RED}Build directory not found. Run ./scripts/build.sh first.${NC}"
    exit 1
fi

# Create server directories if needed
mkdir -p "$SERVER_DIR"
mkdir -p "$LEGACY_DIR"
mkdir -p "$LEGACY_DIR/lua"
mkdir -p "$SERVER_DIR/omni-bot/et/nav"

# Deploy binaries
echo -e "${YELLOW}Deploying binaries...${NC}"
if [ -f "$BUILD_DIR/etlded" ]; then
    cp "$BUILD_DIR/etlded" "$SERVER_DIR/"
    echo "  - etlded (server executable)"
fi
if [ -f "$BUILD_DIR/etl" ]; then
    cp "$BUILD_DIR/etl" "$SERVER_DIR/"
    echo "  - etl (client executable)"
fi

# Deploy legacy mod files
echo -e "${YELLOW}Deploying mod files...${NC}"
for pk3 in "$BUILD_DIR/legacy/"*.pk3; do
    if [ -f "$pk3" ]; then
        cp "$pk3" "$LEGACY_DIR/"
        echo "  - $(basename "$pk3")"
    fi
done

# Deploy qagame (server module)
if [ -f "$BUILD_DIR/legacy/qagame.mp.x86_64.so" ]; then
    cp "$BUILD_DIR/legacy/qagame.mp.x86_64.so" "$LEGACY_DIR/"
    echo "  - qagame.mp.x86_64.so"
elif [ -f "$BUILD_DIR/legacy/qagame.mp.i386.so" ]; then
    cp "$BUILD_DIR/legacy/qagame.mp.i386.so" "$LEGACY_DIR/"
    echo "  - qagame.mp.i386.so"
fi

# Deploy configs from project
echo -e "${YELLOW}Deploying configs...${NC}"
if [ -d "$PROJECT_DIR/configs" ]; then
    cp -r "$PROJECT_DIR/configs/"*.cfg "$LEGACY_DIR/" 2>/dev/null || true
    if [ -d "$PROJECT_DIR/configs/mapconfigs" ]; then
        mkdir -p "$LEGACY_DIR/mapconfigs"
        cp -r "$PROJECT_DIR/configs/mapconfigs/"*.cfg "$LEGACY_DIR/mapconfigs/" 2>/dev/null || true
    fi
    echo "  - Config files synced"
fi

# Deploy Lua scripts
echo -e "${YELLOW}Deploying Lua scripts...${NC}"
if [ -d "$PROJECT_DIR/lua" ] && [ "$(ls -A "$PROJECT_DIR/lua" 2>/dev/null)" ]; then
    cp -r "$PROJECT_DIR/lua/"*.lua "$LEGACY_DIR/lua/" 2>/dev/null || true
    echo "  - Lua scripts synced"
fi

# Deploy maps
echo -e "${YELLOW}Deploying maps...${NC}"
if [ -d "$PROJECT_DIR/maps" ] && [ "$(ls -A "$PROJECT_DIR/maps" 2>/dev/null)" ]; then
    cp "$PROJECT_DIR/maps/"*.pk3 "$LEGACY_DIR/" 2>/dev/null || true
    echo "  - Map pk3s synced"
fi

# Deploy waypoints
echo -e "${YELLOW}Deploying waypoints...${NC}"
if [ -d "$PROJECT_DIR/waypoints" ] && [ "$(ls -A "$PROJECT_DIR/waypoints" 2>/dev/null)" ]; then
    cp "$PROJECT_DIR/waypoints/"*.way "$SERVER_DIR/omni-bot/et/nav/" 2>/dev/null || true
    cp "$PROJECT_DIR/waypoints/"*.gm "$SERVER_DIR/omni-bot/et/nav/" 2>/dev/null || true
    echo "  - Waypoint files synced"
fi

# Deploy mapscripts
echo -e "${YELLOW}Deploying mapscripts...${NC}"
if [ -d "$PROJECT_DIR/mapscripts" ] && [ "$(ls -A "$PROJECT_DIR/mapscripts" 2>/dev/null)" ]; then
    mkdir -p "$LEGACY_DIR/mapscripts"
    cp "$PROJECT_DIR/mapscripts/"*.script "$LEGACY_DIR/mapscripts/" 2>/dev/null || true
    echo "  - Mapscripts synced"
fi

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  Deploy Complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "Server directory: $SERVER_DIR"
echo ""
echo "To start server:"
echo "  cd $SERVER_DIR && ./etlded +set fs_game legacy +exec server.cfg"
