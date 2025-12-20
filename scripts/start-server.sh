#!/bin/bash
#
# Start Local ET:Legacy Server
# For development/testing purposes
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$HOME/etlegacy"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  ET:Legacy Local Server${NC}"
echo -e "${GREEN}================================${NC}"

# Check if server directory exists
if [ ! -d "$SERVER_DIR" ]; then
    echo -e "${RED}Server directory not found: $SERVER_DIR${NC}"
    echo -e "${YELLOW}Run ./scripts/deploy.sh first${NC}"
    exit 1
fi

# Check if server binary exists
if [ ! -f "$SERVER_DIR/etlded.x86_64" ]; then
    echo -e "${RED}Server binary not found: $SERVER_DIR/etlded.x86_64${NC}"
    echo -e "${YELLOW}Run ./scripts/build-all.sh && ./scripts/deploy.sh first${NC}"
    exit 1
fi

cd "$SERVER_DIR"

# Kill any existing server
if pgrep -f "etlded.*legacy" > /dev/null; then
    echo -e "${YELLOW}Stopping existing server...${NC}"
    pkill -f "etlded.*legacy" 2>/dev/null
    sleep 2
fi

echo ""
echo -e "${GREEN}Starting server...${NC}"
echo "  Directory: $SERVER_DIR"
echo "  Port: 27960"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
echo ""

# Start server
./etlded.x86_64 \
    +set fs_game legacy \
    +set fs_basepath "$(pwd)" \
    +set fs_homepath "$(pwd)" \
    +set net_port 27960 \
    +set dedicated 2 \
    +exec server.cfg \
    "$@"
