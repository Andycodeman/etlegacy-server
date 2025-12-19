#!/bin/bash
#
# ET:Legacy Server - Publish Script
# Builds, deploys locally, syncs to remote VM, and restarts server
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Remote server details
REMOTE_HOST="andy@5.78.83.59"
REMOTE_DIR="/home/andy/etlegacy"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  ET:Legacy Server Publish${NC}"
echo -e "${GREEN}================================${NC}"

# Step 1: Build
echo -e "${YELLOW}Step 1: Building...${NC}"
"$SCRIPT_DIR/build.sh"

# Step 2: Deploy locally
echo -e "${YELLOW}Step 2: Deploying locally...${NC}"
"$SCRIPT_DIR/deploy.sh"

# Step 3: Sync to remote
echo -e "${YELLOW}Step 3: Syncing to remote server...${NC}"

LOCAL_SERVER="$HOME/etlegacy"

# Sync binaries
rsync -avz --progress \
    "$LOCAL_SERVER/etlded" \
    "$REMOTE_HOST:$REMOTE_DIR/"

# Sync legacy mod folder (includes pk3s, configs, lua)
rsync -avz --progress --delete \
    --exclude='*.log' \
    --exclude='*.db' \
    --exclude='profiles/' \
    "$LOCAL_SERVER/legacy/" \
    "$REMOTE_HOST:$REMOTE_DIR/legacy/"

# Sync omni-bot waypoints
rsync -avz --progress \
    "$LOCAL_SERVER/omni-bot/et/nav/" \
    "$REMOTE_HOST:$REMOTE_DIR/omni-bot/et/nav/"

# Step 4: Restart remote server
echo -e "${YELLOW}Step 4: Restarting remote server...${NC}"
ssh "$REMOTE_HOST" "sudo systemctl restart etserver || (cd $REMOTE_DIR && ./restart-server.sh)"

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  Publish Complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "Remote server: $REMOTE_HOST"
echo "Connect: /connect et.coolip.me:27960"
