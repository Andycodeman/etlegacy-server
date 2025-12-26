#!/bin/bash
#
# Build script for Voice Chat Test
#
# Usage:
#   ./build.sh          # Build release
#   ./build.sh debug    # Build debug
#   ./build.sh clean    # Clean build
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

# Parse arguments
BUILD_TYPE="Release"
CLEAN=0

for arg in "$@"; do
    case $arg in
        debug|Debug)
            BUILD_TYPE="Debug"
            ;;
        clean|--clean)
            CLEAN=1
            ;;
        -h|--help)
            echo "Usage: $0 [debug|clean]"
            echo "  debug  - Build with debug symbols"
            echo "  clean  - Remove build directory first"
            exit 0
            ;;
    esac
done

# Check dependencies
echo "=== Checking dependencies ==="

check_dep() {
    local pkg="$1"
    local header="$2"
    local lib="$3"

    if pkg-config --exists "$pkg" 2>/dev/null; then
        echo "  $pkg: $(pkg-config --modversion "$pkg")"
        return 0
    fi

    # Fallback: check for header
    for dir in /usr/include /usr/local/include; do
        if [ -f "$dir/$header" ]; then
            echo "  $pkg: found at $dir"
            return 0
        fi
    done

    echo "  $pkg: NOT FOUND"
    return 1
}

MISSING=""
check_dep "portaudio-2.0" "portaudio.h" "libportaudio" || MISSING="$MISSING portaudio"
check_dep "opus" "opus/opus.h" "libopus" || MISSING="$MISSING opus"

if [ -n "$MISSING" ]; then
    echo ""
    echo "ERROR: Missing dependencies:$MISSING"
    echo ""
    echo "Install with:"
    echo "  Ubuntu/Debian: sudo apt install libportaudio2 portaudio19-dev libopus-dev"
    echo "  Fedora:        sudo dnf install portaudio-devel opus-devel"
    echo "  Arch:          sudo pacman -S portaudio opus"
    exit 1
fi

echo ""
echo "=== Building ($BUILD_TYPE) ==="

# Clean if requested
if [ $CLEAN -eq 1 ] && [ -d "$BUILD_DIR" ]; then
    echo "Cleaning $BUILD_DIR..."
    rm -rf "$BUILD_DIR"
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure
cmake -DCMAKE_BUILD_TYPE="$BUILD_TYPE" ..

# Build
cmake --build . --parallel "$(nproc)"

echo ""
echo "=== Build complete ==="
echo ""
echo "Binaries:"
ls -la voice_client voice_server 2>/dev/null || true
echo ""
echo "Run the test:"
echo "  Terminal 1: ./build/voice_server"
echo "  Terminal 2: ./build/voice_client"
echo ""
echo "Hold SPACE to talk in the client."
