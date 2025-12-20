#!/bin/bash
#
# Build Rick Roll Mode pk3
#
# This script packages all Rick Roll assets into a pk3 file
# that can be served to clients for HTTP download.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RICKROLL_DIR="$PROJECT_DIR/rickroll"
DIST_DIR="$PROJECT_DIR/dist"
DATE=$(date +%Y%m%d)

echo "=========================================="
echo "Building Rick Roll Mode pk3"
echo "=========================================="

# Create dist directory if it doesn't exist
mkdir -p "$DIST_DIR"

# Create temp directory for pk3 contents
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "📁 Copying assets..."

# Copy gfx
if [ -d "$RICKROLL_DIR/gfx" ]; then
    cp -r "$RICKROLL_DIR/gfx" "$TEMP_DIR/"
    echo "  ✅ gfx/"
fi

# Copy sound
if [ -d "$RICKROLL_DIR/sound" ]; then
    cp -r "$RICKROLL_DIR/sound" "$TEMP_DIR/"
    echo "  ✅ sound/"
fi

# Copy scripts (shaders)
if [ -d "$RICKROLL_DIR/scripts" ]; then
    cp -r "$RICKROLL_DIR/scripts" "$TEMP_DIR/"
    echo "  ✅ scripts/"
fi

# Create the pk3 (it's just a zip file)
PK3_NAME="etman_rickroll.pk3"
PK3_PATH="$DIST_DIR/$PK3_NAME"

echo ""
echo "📦 Creating pk3: $PK3_NAME"

cd "$TEMP_DIR"
zip -r "$PK3_PATH" . -x "*.DS_Store" -x "*__MACOSX*"

echo ""
echo "=========================================="
echo "✅ Build complete!"
echo "=========================================="
echo ""
echo "Output files:"
ls -lh "$DIST_DIR"/rickroll*.pk3
echo ""
echo "Contents:"
unzip -l "$PK3_PATH"
echo ""
echo "To deploy, run: ./scripts/publish.sh"
