#!/bin/bash
#
# ET:Legacy - Multi-Platform Build Script
# Builds server and client modules for all target platforms
#
# Targets:
#   - Linux 64-bit server (etlded.x86_64)
#   - Linux 32-bit client modules (cgame.mp.i386.so, ui.mp.i386.so)
#   - Linux 64-bit client modules (cgame.mp.x86_64.so, ui.mp.x86_64.so)
#   - Windows 32-bit client modules (cgame_mp_x86.dll, ui_mp_x86.dll)
#   - Windows 64-bit client modules (cgame_mp_x64.dll, ui_mp_x64.dll)
#
# Usage:
#   ./build-all.sh              # Build all targets
#   ./build-all.sh server       # Build server only
#   ./build-all.sh linux        # Build all Linux targets
#   ./build-all.sh windows      # Build all Windows targets
#   ./build-all.sh mod          # Build mod for all client platforms
#   ./build-all.sh --clean      # Clean all build directories first
#   ./build-all.sh --no-voice   # Disable voice chat (enabled by default)
#   ./build-all.sh etman-server # Build standalone etman server only

set -e

# Feature flags - Voice is ON by default
FEATURE_VOICE=ON

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/src"
BUILD_BASE="$PROJECT_DIR/build"
OUTPUT_DIR="$PROJECT_DIR/dist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

print_banner() {
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║          ET:Legacy Multi-Platform Build System               ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Check dependencies
check_deps() {
    log_step "Checking build dependencies..."

    local missing=()

    command -v cmake >/dev/null || missing+=("cmake")
    command -v gcc >/dev/null || missing+=("gcc")
    command -v g++ >/dev/null || missing+=("g++")
    command -v nasm >/dev/null || missing+=("nasm")
    command -v zip >/dev/null || missing+=("zip")

    # Check for 32-bit compilation
    if ! gcc -m32 -x c -c /dev/null -o /dev/null 2>/dev/null; then
        missing+=("gcc-multilib")
    fi

    # Check for Windows cross-compilation
    if ! command -v x86_64-w64-mingw32-gcc >/dev/null; then
        missing+=("mingw-w64 (for Windows builds)")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing dependencies: ${missing[*]}"
        echo "Install with: sudo apt-get install cmake gcc g++ nasm zip gcc-multilib g++-multilib mingw-w64"
        return 1
    fi

    log_info "All dependencies found!"
}

# Build Linux 64-bit server
build_server_linux64() {
    local build_dir="$BUILD_BASE/linux64-server"

    log_step "Building Linux 64-bit server..."

    mkdir -p "$build_dir"
    cd "$build_dir"

    cmake "$SRC_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCROSS_COMPILE32=OFF \
        -DBUILD_SERVER=ON \
        -DBUILD_CLIENT=OFF \
        -DBUILD_MOD=ON \
        -DBUILD_MOD_PK3=OFF \
        -DFEATURE_LUA=ON \
        -DFEATURE_OMNIBOT=ON \
        -DFEATURE_DBMS=ON \
        -DFEATURE_TRACKER=ON \
        -DFEATURE_ANTICHEAT=ON \
        -DINSTALL_EXTRA=OFF \
        -DINSTALL_OMNIBOT=OFF

    make -j$(nproc)

    # Copy output
    mkdir -p "$OUTPUT_DIR/server"
    cp -v etlded.x86_64 "$OUTPUT_DIR/server/" 2>/dev/null || true
    cp -v legacy/qagame.mp.x86_64.so "$OUTPUT_DIR/server/" 2>/dev/null || true

    log_info "Linux 64-bit server built successfully!"
}

# Build Linux client modules (both 32 and 64-bit)
build_mod_linux() {
    local arch=$1  # 32 or 64
    local build_dir="$BUILD_BASE/linux${arch}-mod"

    log_step "Building Linux ${arch}-bit client modules..."

    mkdir -p "$build_dir"
    cd "$build_dir"

    local cross_compile32=OFF
    [ "$arch" = "32" ] && cross_compile32=ON

    cmake "$SRC_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCROSS_COMPILE32=$cross_compile32 \
        -DBUILD_SERVER=OFF \
        -DBUILD_CLIENT=OFF \
        -DBUILD_MOD=ON \
        -DBUILD_CLIENT_MOD=ON \
        -DBUILD_SERVER_MOD=OFF \
        -DBUILD_MOD_PK3=OFF \
        -DFEATURE_LUA=ON \
        -DFEATURE_OMNIBOT=OFF \
        -DFEATURE_VOICE=$FEATURE_VOICE \
        -DINSTALL_EXTRA=OFF

    make -j$(nproc)

    # Copy output
    mkdir -p "$OUTPUT_DIR/mod/linux"
    if [ "$arch" = "32" ]; then
        cp -v legacy/cgame.mp.i386.so "$OUTPUT_DIR/mod/linux/" 2>/dev/null || true
        cp -v legacy/ui.mp.i386.so "$OUTPUT_DIR/mod/linux/" 2>/dev/null || true
    else
        cp -v legacy/cgame.mp.x86_64.so "$OUTPUT_DIR/mod/linux/" 2>/dev/null || true
        cp -v legacy/ui.mp.x86_64.so "$OUTPUT_DIR/mod/linux/" 2>/dev/null || true
    fi

    log_info "Linux ${arch}-bit client modules built successfully!"
}

# Build Windows client modules using MinGW cross-compilation
build_mod_windows() {
    local arch=$1  # 32 or 64
    local build_dir="$BUILD_BASE/win${arch}-mod"

    log_step "Building Windows ${arch}-bit client modules..."

    mkdir -p "$build_dir"
    cd "$build_dir"

    local toolchain
    local processor
    if [ "$arch" = "32" ]; then
        toolchain="$SRC_DIR/cmake/Toolchain-cross-mingw-linux.cmake"
        processor="i386"
    else
        toolchain="$SRC_DIR/cmake/Toolchain-cross-mingw-x64-linux.cmake"
        processor="x86_64"
    fi

    # For 64-bit, explicitly disable CROSS_COMPILE32
    local cross32_flag="OFF"
    [ "$arch" = "32" ] && cross32_flag="ON"

    cmake "$SRC_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE="$toolchain" \
        -DCROSS_COMPILE32=$cross32_flag \
        -DBUILD_SERVER=OFF \
        -DBUILD_CLIENT=OFF \
        -DBUILD_MOD=ON \
        -DBUILD_CLIENT_MOD=ON \
        -DBUILD_SERVER_MOD=OFF \
        -DBUILD_MOD_PK3=OFF \
        -DFEATURE_LUA=ON \
        -DFEATURE_OMNIBOT=OFF \
        -DFEATURE_VOICE=$FEATURE_VOICE \
        -DINSTALL_EXTRA=OFF \
        -DBUNDLED_LIBS=ON

    make -j$(nproc)

    # Copy output - Windows uses _mp_x86 and _mp_x64 naming (NOT .mp.i386 like Linux!)
    mkdir -p "$OUTPUT_DIR/mod/windows"
    if [ "$arch" = "32" ]; then
        # Windows 32-bit: cgame_mp_x86.dll, ui_mp_x86.dll
        [ -f legacy/cgame_mp_x86.dll ] && cp -v legacy/cgame_mp_x86.dll "$OUTPUT_DIR/mod/windows/"
        [ -f legacy/ui_mp_x86.dll ] && cp -v legacy/ui_mp_x86.dll "$OUTPUT_DIR/mod/windows/"
    else
        # Windows 64-bit: cgame_mp_x64.dll, ui_mp_x64.dll
        [ -f legacy/cgame_mp_x64.dll ] && cp -v legacy/cgame_mp_x64.dll "$OUTPUT_DIR/mod/windows/"
        [ -f legacy/ui_mp_x64.dll ] && cp -v legacy/ui_mp_x64.dll "$OUTPUT_DIR/mod/windows/"
    fi

    log_info "Windows ${arch}-bit client modules built successfully!"
}

# Build the etman server (voice + sounds + admin)
build_etman_server() {
    local build_dir="$PROJECT_DIR/etman-server/build"

    log_step "Building etman server..."

    mkdir -p "$build_dir"
    cd "$build_dir"

    cmake ..
    make -j$(nproc)

    # Copy output - fail if binary doesn't exist
    mkdir -p "$OUTPUT_DIR/server"
    if [ -f "$build_dir/etman_server" ]; then
        cp -v "$build_dir/etman_server" "$OUTPUT_DIR/server/"
        log_info "ETMan server built successfully!"
    else
        log_error "ETMan server build failed - binary not found!"
        return 1
    fi
}

# Build the rickroll pk3 (separate from main mod pk3 for HTTP downloads)
build_rickroll_pk3() {
    log_step "Building rickroll pk3..."

    if [ -x "$SCRIPT_DIR/build-rickroll-pk3.sh" ]; then
        "$SCRIPT_DIR/build-rickroll-pk3.sh"
    else
        log_warn "build-rickroll-pk3.sh not found or not executable, skipping rickroll pk3"
    fi
}

# Create the mod pk3 with all client modules
create_mod_pk3() {
    log_step "Creating mod pk3 package..."

    local pk3_dir="$OUTPUT_DIR/pk3"
    # zzz_ prefix ensures it loads AFTER legacy_v2.83.2.pk3 (alphabetical order)
    local pk3_name="zzz_etman_etlegacy.pk3"

    mkdir -p "$pk3_dir"
    cd "$pk3_dir"

    # Copy all built modules to ROOT of pk3 (NOT inside legacy/ folder!)
    # ET:Legacy loads modules from pk3 root, not from subdirectories

    # Linux modules
    [ -f "$OUTPUT_DIR/mod/linux/cgame.mp.i386.so" ] && cp "$OUTPUT_DIR/mod/linux/cgame.mp.i386.so" .
    [ -f "$OUTPUT_DIR/mod/linux/cgame.mp.x86_64.so" ] && cp "$OUTPUT_DIR/mod/linux/cgame.mp.x86_64.so" .
    [ -f "$OUTPUT_DIR/mod/linux/ui.mp.i386.so" ] && cp "$OUTPUT_DIR/mod/linux/ui.mp.i386.so" .
    [ -f "$OUTPUT_DIR/mod/linux/ui.mp.x86_64.so" ] && cp "$OUTPUT_DIR/mod/linux/ui.mp.x86_64.so" .

    # Windows modules - use correct _mp_x86/_mp_x64 naming convention
    [ -f "$OUTPUT_DIR/mod/windows/cgame_mp_x86.dll" ] && cp "$OUTPUT_DIR/mod/windows/cgame_mp_x86.dll" .
    [ -f "$OUTPUT_DIR/mod/windows/cgame_mp_x64.dll" ] && cp "$OUTPUT_DIR/mod/windows/cgame_mp_x64.dll" .
    [ -f "$OUTPUT_DIR/mod/windows/ui_mp_x86.dll" ] && cp "$OUTPUT_DIR/mod/windows/ui_mp_x86.dll" .
    [ -f "$OUTPUT_DIR/mod/windows/ui_mp_x64.dll" ] && cp "$OUTPUT_DIR/mod/windows/ui_mp_x64.dll" .

    # Copy Lua scripts
    if [ -d "$PROJECT_DIR/lua" ]; then
        cp -r "$PROJECT_DIR/lua" .
    fi

    # Copy custom weapon definitions (e.g., modified panzerfaust.weap)
    if [ -d "$PROJECT_DIR/weapons" ]; then
        cp -r "$PROJECT_DIR/weapons" .
    fi

    # Copy Rick Roll assets (gfx, scripts, sound)
    if [ -d "$PROJECT_DIR/rickroll" ]; then
        log_info "Including Rick Roll assets..."
        [ -d "$PROJECT_DIR/rickroll/gfx" ] && cp -r "$PROJECT_DIR/rickroll/gfx" .
        [ -d "$PROJECT_DIR/rickroll/scripts" ] && cp -r "$PROJECT_DIR/rickroll/scripts" .
        [ -d "$PROJECT_DIR/rickroll/sound" ] && cp -r "$PROJECT_DIR/rickroll/sound" .
    fi

    # Copy custom UI menu files (overrides for controls, etc.)
    if [ -d "$SRC_DIR/etmain/ui" ]; then
        log_info "Including custom UI menus..."
        mkdir -p ui
        cp "$SRC_DIR/etmain/ui/options_controls.menu" ui/ 2>/dev/null || true
        cp "$SRC_DIR/etmain/ui/ingame_serverinfo.menu" ui/ 2>/dev/null || true
        cp "$SRC_DIR/etmain/ui/options.menu" ui/ 2>/dev/null || true
        cp "$SRC_DIR/etmain/ui/options_voice.menu" ui/ 2>/dev/null || true
        cp "$SRC_DIR/etmain/ui/menus.txt" ui/ 2>/dev/null || true
    fi

    # Create pk3 with modules at root level
    # List what we're packaging
    log_info "Packaging the following files:"
    ls -la *.so *.dll 2>/dev/null || true

    rm -f "$OUTPUT_DIR/$pk3_name"
    # Include all available directories: modules + lua + weapons + rickroll assets + ui
    zip -r "$OUTPUT_DIR/$pk3_name" *.so *.dll lua/ weapons/ gfx/ scripts/ sound/ ui/ 2>/dev/null \
        || zip -r "$OUTPUT_DIR/$pk3_name" *.so *.dll lua/ gfx/ scripts/ sound/ ui/ 2>/dev/null \
        || zip -r "$OUTPUT_DIR/$pk3_name" *.so *.dll lua/ ui/ 2>/dev/null \
        || zip -r "$OUTPUT_DIR/$pk3_name" *.so *.dll lua/ 2>/dev/null \
        || zip -r "$OUTPUT_DIR/$pk3_name" *.so *.dll

    # Cleanup
    rm -f *.so *.dll
    rm -rf lua weapons gfx scripts sound ui

    log_info "Created $OUTPUT_DIR/$pk3_name"
}

# Clean all build directories
clean_all() {
    log_step "Cleaning all build directories..."
    rm -rf "$BUILD_BASE"
    rm -rf "$OUTPUT_DIR"
    log_info "Clean complete!"
}

# Main build flow
main() {
    print_banner

    local target="${1:-all}"
    local clean=false

    # Parse arguments
    for arg in "$@"; do
        case $arg in
            --clean)
                clean=true
                ;;
            --no-voice)
                FEATURE_VOICE=OFF
                log_info "Voice chat feature DISABLED"
                ;;
        esac
    done

    if [ "$clean" = true ]; then
        clean_all
        [ "$target" = "--clean" ] && exit 0
    fi

    check_deps || exit 1

    mkdir -p "$OUTPUT_DIR"

    case $target in
        all)
            build_server_linux64
            build_mod_linux 32
            build_mod_linux 64
            build_mod_windows 32
            build_mod_windows 64
            create_mod_pk3
            build_rickroll_pk3
            build_etman_server
            ;;
        server)
            build_server_linux64
            build_etman_server
            ;;
        linux)
            build_server_linux64
            build_mod_linux 32
            build_mod_linux 64
            build_etman_server
            ;;
        windows)
            build_mod_windows 32
            build_mod_windows 64
            ;;
        mod)
            build_mod_linux 32
            build_mod_linux 64
            build_mod_windows 32
            build_mod_windows 64
            create_mod_pk3
            build_rickroll_pk3
            build_etman_server
            ;;
        linux32)
            build_mod_linux 32
            ;;
        linux64)
            build_mod_linux 64
            ;;
        win32)
            build_mod_windows 32
            ;;
        win64)
            build_mod_windows 64
            ;;
        pk3)
            create_mod_pk3
            ;;
        etman-server)
            build_etman_server
            ;;
        clean)
            clean_all
            ;;
        *)
            echo "Usage: $0 [target] [--clean] [--voice]"
            echo ""
            echo "Targets:"
            echo "  all          - Build everything (default)"
            echo "  server       - Build Linux 64-bit server only"
            echo "  linux        - Build all Linux targets"
            echo "  windows      - Build all Windows targets"
            echo "  mod          - Build client modules for all platforms + pk3"
            echo "  linux32      - Build Linux 32-bit client modules"
            echo "  linux64      - Build Linux 64-bit client modules"
            echo "  win32        - Build Windows 32-bit client modules"
            echo "  win64        - Build Windows 64-bit client modules"
            echo "  pk3          - Create mod pk3 from existing builds"
            echo "  etman-server - Build standalone ETMan server (voice + sounds + admin)"
            echo "  clean        - Remove all build directories"
            echo ""
            echo "Options:"
            echo "  --clean    - Clean before building"
            echo "  --no-voice - Disable voice chat feature (enabled by default)"
            exit 1
            ;;
    esac

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    Build Complete!                           ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Output directory: $OUTPUT_DIR"
    echo ""
    ls -la "$OUTPUT_DIR" 2>/dev/null || true
}

main "$@"
