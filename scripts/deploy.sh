#!/bin/bash
#
# ET:Legacy Server - Local Deploy Script
# Deploys built binaries and configs to local server directory
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
BUILD_DIR="$PROJECT_DIR/build/linux64-server"
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
if [ ! -d "$DIST_DIR/server" ] && [ ! -d "$BUILD_DIR" ]; then
    echo -e "${RED}Build not found. Run ./scripts/build-all.sh first.${NC}"
    exit 1
fi

# Create server directories if needed
mkdir -p "$SERVER_DIR"
mkdir -p "$LEGACY_DIR"
mkdir -p "$LEGACY_DIR/lua"
mkdir -p "$SERVER_DIR/omni-bot/et/nav"

# Deploy server executable
echo -e "${YELLOW}Deploying server executable...${NC}"
if [ -f "$DIST_DIR/server/etlded.x86_64" ]; then
    cp "$DIST_DIR/server/etlded.x86_64" "$SERVER_DIR/"
    echo "  - etlded.x86_64"
elif [ -f "$BUILD_DIR/etlded.x86_64" ]; then
    cp "$BUILD_DIR/etlded.x86_64" "$SERVER_DIR/"
    echo "  - etlded.x86_64"
fi

# Deploy qagame (server module)
echo -e "${YELLOW}Deploying server module...${NC}"
if [ -f "$DIST_DIR/server/qagame.mp.x86_64.so" ]; then
    cp "$DIST_DIR/server/qagame.mp.x86_64.so" "$LEGACY_DIR/"
    echo "  - qagame.mp.x86_64.so"
elif [ -f "$BUILD_DIR/legacy/qagame.mp.x86_64.so" ]; then
    cp "$BUILD_DIR/legacy/qagame.mp.x86_64.so" "$LEGACY_DIR/"
    echo "  - qagame.mp.x86_64.so"
fi

# Deploy legacy mod pk3 (from dist or from build)
echo -e "${YELLOW}Deploying mod pk3s...${NC}"
# Remove old etman pk3s (all naming variations)
rm -f "$LEGACY_DIR/"etman_*.pk3
rm -f "$LEGACY_DIR/"zzz_etman*.pk3
rm -f "$LEGACY_DIR/"zzz-etman*.pk3
# Copy new ones (zzz_ prefix loads AFTER legacy_v2.83.2.pk3)
if ls "$DIST_DIR/"zzz_etman*.pk3 1>/dev/null 2>&1; then
    cp "$DIST_DIR/"zzz_etman*.pk3 "$LEGACY_DIR/"
    echo "  - Custom mod pk3 deployed (zzz_etman_etlegacy.pk3)"
elif ls "$DIST_DIR/"etman_*.pk3 1>/dev/null 2>&1; then
    cp "$DIST_DIR/"etman_*.pk3 "$LEGACY_DIR/"
    echo "  - Custom mod pk3 deployed"
fi

# IMPORTANT: Do NOT copy built legacy_*.pk3 - it's a "dirty" build that breaks sv_pure!
# The official legacy_v2.83.2.pk3 must be manually installed and never overwritten.
# Custom mods go in zzz_etman_etlegacy.pk3 (loads after base, overrides).
#
# if [ -f "$BUILD_DIR/legacy/legacy_"*.pk3 ]; then
#     cp "$BUILD_DIR/legacy/legacy_"*.pk3 "$LEGACY_DIR/"
#     echo "  - legacy_*.pk3 (base assets)"
# fi

# Deploy configs from project
echo -e "${YELLOW}Deploying configs...${NC}"
if [ -d "$PROJECT_DIR/configs" ]; then
    cp "$PROJECT_DIR/configs/"*.cfg "$LEGACY_DIR/" 2>/dev/null || true
    if [ -d "$PROJECT_DIR/configs/mapconfigs" ]; then
        mkdir -p "$LEGACY_DIR/mapconfigs"
        cp "$PROJECT_DIR/configs/mapconfigs/"*.cfg "$LEGACY_DIR/mapconfigs/" 2>/dev/null || true
    fi
    echo "  - Config files synced"
fi

# Deploy Lua scripts (including subdirectories like rickroll/)
echo -e "${YELLOW}Deploying Lua scripts...${NC}"
if [ -d "$PROJECT_DIR/lua" ] && [ "$(ls -A "$PROJECT_DIR/lua" 2>/dev/null)" ]; then
    # Copy root lua files
    cp "$PROJECT_DIR/lua/"*.lua "$LEGACY_DIR/lua/" 2>/dev/null || true
    # Copy subdirectories (like rickroll/)
    for subdir in "$PROJECT_DIR/lua"/*/; do
        if [ -d "$subdir" ]; then
            dirname=$(basename "$subdir")
            mkdir -p "$LEGACY_DIR/lua/$dirname"
            cp "$subdir"*.lua "$LEGACY_DIR/lua/$dirname/" 2>/dev/null || true
            echo "  - lua/$dirname/ synced"
        fi
    done
    echo "  - Lua scripts synced"
fi

# Deploy rickroll pk3 (assets for HTTP download)
echo -e "${YELLOW}Deploying Rick Roll assets...${NC}"
if [ -f "$DIST_DIR/etman_rickroll.pk3" ]; then
    cp "$DIST_DIR/etman_rickroll.pk3" "$LEGACY_DIR/"
    echo "  - etman_rickroll.pk3 deployed"
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
echo "  cd $SERVER_DIR && ./etlded.x86_64 +set fs_game legacy +exec server.cfg"
