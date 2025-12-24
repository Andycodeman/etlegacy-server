#!/bin/bash
#
# ET:Legacy Server - Publish Script
# Deploys locally, syncs to remote VM, and restarts server
#
# This replaces the OLD JayMod server with the NEW ET:Legacy server
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

# Remote server details
REMOTE_HOST="andy@5.78.83.59"
REMOTE_DIR="/home/andy/etlegacy"

# SSH connection multiplexing - reuse single connection for all SSH/rsync calls
SSH_CONTROL_PATH="/tmp/ssh-et-publish-%r@%h:%p"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$SSH_CONTROL_PATH -o ControlPersist=60"
export RSYNC_RSH="ssh $SSH_OPTS"

# Start master connection
ssh $SSH_OPTS -fNM "$REMOTE_HOST" 2>/dev/null || true

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          ET:Legacy Server Publish to VPS                     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"

# Check if dist exists
if [ ! -d "$DIST_DIR/server" ]; then
    echo -e "${RED}Build not found. Run ./scripts/build-all.sh first.${NC}"
    exit 1
fi

# Step 1: Deploy locally first
echo -e "${YELLOW}Step 1: Deploying locally...${NC}"
"$SCRIPT_DIR/deploy.sh"

LOCAL_SERVER="$HOME/etlegacy"

# Step 2: Sync server binary
echo -e "${YELLOW}Step 2: Syncing server binary to VPS...${NC}"
rsync -avz --progress \
    "$LOCAL_SERVER/etlded.x86_64" \
    "$REMOTE_HOST:$REMOTE_DIR/"

# Step 3: Sync legacy mod folder (configs, pk3s, lua, qagame)
# CRITICAL: Never sync legacy_v2.83.2_dirty.pk3 or delete official legacy_v2.83.2.pk3
#           The official pk3 MUST match client version for sv_pure to work!
echo -e "${YELLOW}Step 3: Syncing legacy mod folder...${NC}"
rsync -avz --progress --delete \
    --exclude='*.log' \
    --exclude='*.db' \
    --exclude='profiles/' \
    --exclude='etpanel_events.json' \
    --exclude='legacy_v2.83.2.pk3' \
    --exclude='legacy_v2.83.2_dirty.pk3' \
    "$LOCAL_SERVER/legacy/" \
    "$REMOTE_HOST:$REMOTE_DIR/legacy/"

# Step 3b: Sync lua subdirectories (rickroll, etc.)
echo -e "${YELLOW}Step 3b: Syncing Lua subdirectories...${NC}"
rsync -avz --progress \
    "$LOCAL_SERVER/legacy/lua/" \
    "$REMOTE_HOST:$REMOTE_DIR/legacy/lua/"

# Step 4: Sync omni-bot waypoints
echo -e "${YELLOW}Step 4: Syncing omni-bot waypoints...${NC}"
rsync -avz --progress \
    "$LOCAL_SERVER/omni-bot/et/nav/" \
    "$REMOTE_HOST:$REMOTE_DIR/omni-bot/et/nav/" 2>/dev/null || echo "  (No waypoints to sync)"

# Step 4b: Sync server-monitor.sh
echo -e "${YELLOW}Step 4b: Syncing server-monitor.sh...${NC}"
rsync -avz --progress \
    "$PROJECT_DIR/scripts/server-monitor.sh" \
    "$REMOTE_HOST:$REMOTE_DIR/server-monitor.sh"
ssh $SSH_OPTS "$REMOTE_HOST" "chmod +x $REMOTE_DIR/server-monitor.sh"

# Step 5: Update systemd service file on VPS
echo -e "${YELLOW}Step 5: Updating etserver.service on VPS...${NC}"
ssh $SSH_OPTS "$REMOTE_HOST" "cat > /tmp/etserver.service << 'EOF'
[Unit]
Description=ET:Legacy Server
After=network.target

[Service]
Type=simple
User=andy
WorkingDirectory=/home/andy/etlegacy
ExecStart=/home/andy/etlegacy/etlded.x86_64 +set fs_game legacy +exec server.cfg +set net_port 27960
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo mv /tmp/etserver.service /etc/systemd/system/etserver.service && sudo systemctl daemon-reload"

echo "  - etserver.service updated for ET:Legacy (64-bit)"

# Step 6: Restart server and monitor
echo -e "${YELLOW}Step 6: Restarting services...${NC}"
ssh $SSH_OPTS "$REMOTE_HOST" "
    echo '  Restarting etserver...'
    sudo systemctl restart etserver
    sleep 2

    echo '  Restarting et-monitor...'
    sudo systemctl restart et-monitor 2>/dev/null || echo '    (et-monitor service not found)'

    echo '  Service status:'
    sudo systemctl status etserver --no-pager -l | head -5
" || {
    echo -e "${RED}Service restart may have failed. Check manually.${NC}"
}

# Verify services are running
echo -e "${YELLOW}Step 7: Verifying services...${NC}"
sleep 2
ssh $SSH_OPTS "$REMOTE_HOST" "
    if pgrep -f etlded.x86_64 > /dev/null; then
        echo '  ✓ etserver running'
    else
        echo '  ✗ etserver NOT running'
    fi

    if pgrep -f server-monitor.sh > /dev/null; then
        echo '  ✓ et-monitor running'
    else
        echo '  ✗ et-monitor NOT running'
    fi
"

# Step 8: Update local ET client pk3 (for testing)
echo -e "${YELLOW}Step 8: Updating local ET client pk3...${NC}"
PK3_NAME="zzz_etman_etlegacy.pk3"
CLIENT_LEGACY="$HOME/.var/app/com.etlegacy.ETLegacy/.etlegacy/legacy"
if [ -d "$CLIENT_LEGACY" ]; then
    # Remove any loose .so/.dll files that might override pk3
    rm -f "$CLIENT_LEGACY"/*.so "$CLIENT_LEGACY"/*.dll 2>/dev/null && echo "  - Cleaned loose module files from client"
    # Copy pk3 to dlcache
    mkdir -p "$CLIENT_LEGACY/dlcache"
    cp "$DIST_DIR/$PK3_NAME" "$CLIENT_LEGACY/dlcache/"
    echo "  - Updated client dlcache pk3"
else
    echo "  - Client folder not found (skipping)"
fi

# Step 9: Validate pk3 checksums match across all locations
echo -e "${YELLOW}Step 9: Validating pk3 checksums...${NC}"
DIST_MD5=$(md5sum "$DIST_DIR/$PK3_NAME" 2>/dev/null | cut -d' ' -f1)
LOCAL_MD5=$(md5sum "$LOCAL_SERVER/legacy/$PK3_NAME" 2>/dev/null | cut -d' ' -f1)
REMOTE_MD5=$(ssh $SSH_OPTS "$REMOTE_HOST" "md5sum $REMOTE_DIR/legacy/$PK3_NAME 2>/dev/null | cut -d' ' -f1")
CLIENT_MD5=$(md5sum "$CLIENT_LEGACY/dlcache/$PK3_NAME" 2>/dev/null | cut -d' ' -f1)

echo "  Dist:   $DIST_MD5"
echo "  Local:  $LOCAL_MD5"
echo "  VPS:    $REMOTE_MD5"
echo "  Client: $CLIENT_MD5"

if [ "$DIST_MD5" = "$LOCAL_MD5" ] && [ "$LOCAL_MD5" = "$REMOTE_MD5" ] && [ "$REMOTE_MD5" = "$CLIENT_MD5" ]; then
    echo -e "  ${GREEN}✓ All pk3 checksums match!${NC}"
else
    echo -e "  ${RED}✗ CHECKSUM MISMATCH! Players may get kicked by sv_pure.${NC}"
    echo -e "  ${RED}  Run this script again or manually sync the pk3 files.${NC}"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Publish Complete!                         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Remote server: $REMOTE_HOST"
echo "Connect: /connect et.coolip.me:27960"
echo ""
echo "Commands:"
echo "  ssh $REMOTE_HOST 'sudo systemctl status etserver'   # Check status"
echo "  ssh $REMOTE_HOST 'journalctl -u etserver -f'        # View logs"
