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

# Step 4: Sync maps_repo/ for Dynamic Map Loader
echo -e "${YELLOW}Step 4: Syncing maps_repo/ to VPS...${NC}"
rsync -avz --progress \
    "$LOCAL_SERVER/maps_repo/" \
    "$REMOTE_HOST:$REMOTE_DIR/maps_repo/"

# Step 4a: Sync map_switch.sh script
echo -e "${YELLOW}Step 4a: Syncing map_switch.sh...${NC}"
rsync -avz --progress \
    "$LOCAL_SERVER/scripts/map_switch.sh" \
    "$REMOTE_HOST:$REMOTE_DIR/scripts/"
ssh $SSH_OPTS "$REMOTE_HOST" "chmod +x $REMOTE_DIR/scripts/map_switch.sh"

# Step 4b: Sync omni-bot waypoints and custom scripts
echo -e "${YELLOW}Step 4b: Syncing omni-bot waypoints and scripts...${NC}"
rsync -avz --progress \
    "$LOCAL_SERVER/omni-bot/et/nav/" \
    "$REMOTE_HOST:$REMOTE_DIR/omni-bot/et/nav/" 2>/dev/null || echo "  (No waypoints to sync)"
# Sync custom omnibot scripts (et_autoexec.gm forces bots to soldier class)
if [ -d "$PROJECT_DIR/omni-bot/et/scripts" ]; then
    rsync -avz --progress \
        "$PROJECT_DIR/omni-bot/et/scripts/" \
        "$REMOTE_HOST:$REMOTE_DIR/omni-bot/et/scripts/"
    echo "  - Custom omnibot scripts synced"
fi
# Sync omnibot user config (difficulty, moveskill, etc.)
if [ -d "$PROJECT_DIR/omni-bot/et/user" ]; then
    rsync -avz --progress \
        "$PROJECT_DIR/omni-bot/et/user/" \
        "$REMOTE_HOST:$REMOTE_DIR/omni-bot/et/user/"
    echo "  - Omnibot user config synced"
fi

# Step 4c: Sync server-monitor.sh
echo -e "${YELLOW}Step 4c: Syncing server-monitor.sh...${NC}"
rsync -avz --progress \
    "$PROJECT_DIR/scripts/server-monitor.sh" \
    "$REMOTE_HOST:$REMOTE_DIR/server-monitor.sh"
ssh $SSH_OPTS "$REMOTE_HOST" "chmod +x $REMOTE_DIR/server-monitor.sh"

# Step 5: Update systemd service file on VPS (with Dynamic Map Loader support)
echo -e "${YELLOW}Step 5: Updating etserver.service on VPS...${NC}"
ssh $SSH_OPTS "$REMOTE_HOST" "cat > /tmp/etserver.service << 'EOF'
[Unit]
Description=ET:Legacy Server
After=network.target

[Service]
Type=simple
User=andy
WorkingDirectory=/home/andy/etlegacy

# Dynamic Map Loader: Set up initial map symlink before starting server
# This creates symlink in legacy/ pointing to maps_repo/baserace.pk3
ExecStartPre=/home/andy/etlegacy/scripts/map_switch.sh baserace

# Start server with initial map (symlink already in place from ExecStartPre)
ExecStart=/home/andy/etlegacy/etlded.x86_64 +set fs_game legacy +exec server.cfg +set net_port 27960 +map baserace

Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo mv /tmp/etserver.service /etc/systemd/system/etserver.service && sudo systemctl daemon-reload"

echo "  - etserver.service updated with Dynamic Map Loader support"

# Step 5b: Sync etman server binary
echo -e "${YELLOW}Step 5b: Syncing etman server to VPS...${NC}"
# Check build directory first (where build.sh outputs), then fallback to dist
ETMAN_SERVER_SRC="$PROJECT_DIR/etman-server/build/etman_server"
if [ ! -f "$ETMAN_SERVER_SRC" ]; then
    ETMAN_SERVER_SRC="$PROJECT_DIR/dist/server/etman_server"
fi
if [ -f "$ETMAN_SERVER_SRC" ]; then
    # Stop etman-server first so binary isn't locked
    ssh $SSH_OPTS "$REMOTE_HOST" "sudo systemctl stop etman-server 2>/dev/null || true"
    rsync -avz --progress \
        "$ETMAN_SERVER_SRC" \
        "$REMOTE_HOST:$REMOTE_DIR/"
    ssh $SSH_OPTS "$REMOTE_HOST" "chmod +x $REMOTE_DIR/etman_server"
    echo "  - etman_server synced from $ETMAN_SERVER_SRC"
else
    echo -e "${RED}  - ERROR: etman_server not found! Build it first with: ./scripts/build-all.sh${NC}"
fi

# Step 5c: Create/update etman-server.service on VPS
# Note: DATABASE_URL uses etpanel123 password (set Dec 2025)
echo -e "${YELLOW}Step 5c: Updating etman-server.service on VPS...${NC}"
ssh $SSH_OPTS "$REMOTE_HOST" "cat > /tmp/etman-server.service << 'EOF'
[Unit]
Description=ET:Legacy ETMan Server (Voice + Sounds + Admin)
After=network.target etserver.service postgresql.service
Wants=etserver.service

[Service]
Type=simple
User=andy
WorkingDirectory=/home/andy/etlegacy
Environment="DATABASE_URL=postgresql://etpanel:etpanel123@localhost:5432/etpanel"
ExecStart=/home/andy/etlegacy/etman_server 27961 27960
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
sudo mv /tmp/etman-server.service /etc/systemd/system/etman-server.service && sudo systemctl daemon-reload && sudo systemctl enable etman-server"
echo "  - etman-server.service updated"

# Step 6: Restart server and monitor
echo -e "${YELLOW}Step 6: Restarting services...${NC}"
ssh $SSH_OPTS "$REMOTE_HOST" "
    echo '  Restarting etserver...'
    sudo systemctl restart etserver
    sleep 2

    echo '  Restarting etman-server...'
    sudo systemctl restart etman-server 2>/dev/null || echo '    (etman-server not started - may need etman_server binary)'

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

    if pgrep -f etman_server > /dev/null; then
        echo '  ✓ etman-server running (port 27961)'
    else
        echo '  ✗ etman-server NOT running'
    fi

    if pgrep -f server-monitor.sh > /dev/null; then
        echo '  ✓ et-monitor running'
    else
        echo '  ✗ et-monitor NOT running'
    fi
"

# Step 8: Clean local ET client pk3 (force re-download from server)
echo -e "${YELLOW}Step 8: Cleaning local ET client pk3 (to test downloads)...${NC}"
PK3_NAME="zzz_etman_etlegacy.pk3"
CLIENT_LEGACY="$HOME/.var/app/com.etlegacy.ETLegacy/.etlegacy/legacy"
if [ -d "$CLIENT_LEGACY" ]; then
    # Remove any loose .so/.dll files that might override pk3
    rm -f "$CLIENT_LEGACY"/*.so "$CLIENT_LEGACY"/*.dll 2>/dev/null && echo "  - Cleaned loose module files from client"
    # Remove pk3 from dlcache to force re-download
    rm -f "$CLIENT_LEGACY/dlcache/$PK3_NAME" 2>/dev/null && echo "  - Removed client dlcache pk3 (will re-download on connect)"
else
    echo "  - Client folder not found (skipping)"
fi

# Step 9: Validate pk3 checksums match across all locations
echo -e "${YELLOW}Step 9: Validating pk3 checksums...${NC}"
DIST_MD5=$(md5sum "$DIST_DIR/$PK3_NAME" 2>/dev/null | cut -d' ' -f1)
LOCAL_MD5=$(md5sum "$LOCAL_SERVER/legacy/$PK3_NAME" 2>/dev/null | cut -d' ' -f1)
REMOTE_MD5=$(ssh $SSH_OPTS "$REMOTE_HOST" "md5sum $REMOTE_DIR/legacy/$PK3_NAME 2>/dev/null | cut -d' ' -f1")

echo "  Dist:   $DIST_MD5"
echo "  Local:  $LOCAL_MD5"
echo "  VPS:    $REMOTE_MD5"

if [ "$DIST_MD5" = "$LOCAL_MD5" ] && [ "$LOCAL_MD5" = "$REMOTE_MD5" ]; then
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
echo "Connect: /connect et.etman.dev:27960"
echo ""
echo "Commands:"
echo "  ssh $REMOTE_HOST 'sudo systemctl status etserver'   # Check status"
echo "  ssh $REMOTE_HOST 'journalctl -u etserver -f'        # View logs"
