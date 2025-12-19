#!/bin/bash
#
# ET:Legacy Server - Build Script
# Builds the ET:Legacy engine and mod from source
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/src"
BUILD_DIR="$PROJECT_DIR/build"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  ET:Legacy Server Build${NC}"
echo -e "${GREEN}================================${NC}"

# Parse arguments
BUILD_TYPE="Release"
CLEAN=false
BITS="64"

while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            BUILD_TYPE="Debug"
            shift
            ;;
        --clean)
            CLEAN=true
            shift
            ;;
        --32)
            BITS="32"
            shift
            ;;
        --64)
            BITS="64"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--debug] [--clean] [--32|--64]"
            exit 1
            ;;
    esac
done

echo -e "${YELLOW}Build type: ${BUILD_TYPE}${NC}"
echo -e "${YELLOW}Architecture: ${BITS}-bit${NC}"

# Clean if requested
if [ "$CLEAN" = true ]; then
    echo -e "${YELLOW}Cleaning build directory...${NC}"
    rm -rf "$BUILD_DIR"
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with CMake
echo -e "${GREEN}Configuring with CMake...${NC}"

CMAKE_OPTS=(
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE"
    -DBUILD_SERVER=ON
    -DBUILD_CLIENT=ON
    -DBUILD_MOD=ON
    -DBUILD_MOD_PK3=ON
    -DFEATURE_RENDERER2=OFF
    -DFEATURE_RENDERER_GLES=OFF
    -DFEATURE_CURL=ON
    -DFEATURE_OGG_VORBIS=ON
    -DFEATURE_THEORA=OFF
    -DFEATURE_OPENAL=ON
    -DFEATURE_FREETYPE=ON
    -DFEATURE_PNG=ON
    -DFEATURE_LUA=ON
    -DFEATURE_MULTIVIEW=OFF
    -DFEATURE_ANTICHEAT=ON
    -DFEATURE_DBMS=ON
    -DFEATURE_AUTOUPDATE=OFF
    -DINSTALL_DEFAULT_BASEDIR="$HOME/etlegacy"
    -DINSTALL_DEFAULT_MODDIR="legacy"
)

if [ "$BITS" = "32" ]; then
    CMAKE_OPTS+=(-DCROSS_COMPILE32=ON)
fi

cmake "${CMAKE_OPTS[@]}" "$SRC_DIR"

# Build
echo -e "${GREEN}Building...${NC}"
make -j$(nproc)

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  Build Complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "Output in: $BUILD_DIR"
echo ""
echo "Next steps:"
echo "  ./scripts/deploy.sh    - Deploy to local server"
echo "  ./scripts/publish.sh   - Deploy + sync to remote VM"
