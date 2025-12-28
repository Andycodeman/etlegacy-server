#!/bin/bash
#
# ET:Legacy Dynamic Map Loader - Symlink Manager
#
# Usage: map_switch.sh <mapname>
# Example: map_switch.sh baserace
#
# This script manages map pk3 symlinks to enable on-demand map downloads.
# Instead of requiring clients to download ALL maps upfront, they only
# download the current map when joining.
#
# How it works:
# 1. Map pk3s are stored in maps_repo/ (outside sv_pure scan)
# 2. Only the CURRENT map is symlinked into legacy/
# 3. sv_pure checksum recalculates on each map change (FS_Restart)
# 4. Clients only download what they need for the current map
#

set -e

LEGACY_DIR="${LEGACY_DIR:-/home/andy/etlegacy/legacy}"
MAPS_REPO="${MAPS_REPO:-/home/andy/etlegacy/maps_repo}"
MAP_NAME="$1"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# =============================================================================
# MAP NAME -> PK3 FILE MAPPING
# =============================================================================
# When the BSP name inside a pk3 doesn't match the pk3 filename, add a mapping.
# Format: MAP_PK3["bsp_name"]="pk3_filename.pk3"
# Example: capuzzo.bsp is inside capuzzo_final.pk3
# =============================================================================
declare -A MAP_PK3=(
    ["capuzzo"]="capuzzo_final.pk3"
    # Add more mappings as needed:
    # ["et_mor2_night"]="et_mor2_night_final.pk3"
)

# Validate input
if [ -z "$MAP_NAME" ]; then
    echo -e "${RED}ERROR: Map name required${NC}"
    echo "Usage: $0 <mapname>"
    echo "Example: $0 baserace"
    exit 1
fi

# Ensure directories exist
if [ ! -d "$LEGACY_DIR" ]; then
    echo -e "${RED}ERROR: Legacy directory not found: $LEGACY_DIR${NC}"
    exit 1
fi

if [ ! -d "$MAPS_REPO" ]; then
    echo -e "${RED}ERROR: Maps repo not found: $MAPS_REPO${NC}"
    exit 1
fi

# Resolve pk3 filename (check mapping first, then default to mapname.pk3)
if [ -n "${MAP_PK3[$MAP_NAME]}" ]; then
    PK3_FILE="${MAP_PK3[$MAP_NAME]}"
    echo -e "${YELLOW}Using mapped pk3: $MAP_NAME -> $PK3_FILE${NC}"
else
    PK3_FILE="${MAP_NAME}.pk3"
fi

# Check if map exists in repo
if [ ! -f "$MAPS_REPO/$PK3_FILE" ]; then
    echo -e "${RED}ERROR: Map not found: $MAPS_REPO/$PK3_FILE${NC}"
    echo "Available maps:"
    ls -1 "$MAPS_REPO"/*.pk3 2>/dev/null | xargs -n1 basename | sed 's/.pk3$//'
    exit 1
fi

# Remove all existing map symlinks (but preserve real pk3 files like legacy_*.pk3, zzz_*.pk3)
echo -e "${YELLOW}Removing old map symlinks...${NC}"
for link in "$LEGACY_DIR"/*.pk3; do
    if [ -L "$link" ]; then
        linkname=$(basename "$link")
        rm "$link"
        echo "  Removed symlink: $linkname"
    fi
done

# Create symlink for new map
# Note: Symlink name = pk3 filename (not map name) so ET finds it correctly
echo -e "${YELLOW}Creating symlink for: $PK3_FILE${NC}"
ln -sf "$MAPS_REPO/$PK3_FILE" "$LEGACY_DIR/$PK3_FILE"

# Verify symlink was created
if [ -L "$LEGACY_DIR/$PK3_FILE" ]; then
    echo -e "${GREEN}SUCCESS: Switched to map: $MAP_NAME${NC}"
    echo "  Symlink: $LEGACY_DIR/$PK3_FILE -> $MAPS_REPO/$PK3_FILE"
else
    echo -e "${RED}ERROR: Failed to create symlink${NC}"
    exit 1
fi
