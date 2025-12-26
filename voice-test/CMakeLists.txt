# Voice Chat Standalone Test - CMakeLists.txt
#
# Builds the voice chat proof-of-concept:
#   - voice_client: Capture → Encode → Send/Receive → Decode → Play
#   - voice_server: Simple UDP echo server
#
# Dependencies:
#   - PortAudio v19.7.0+
#   - libopus v1.3.1+
#
# Build:
#   mkdir build && cd build
#   cmake ..
#   make
#
# Or use the build script:
#   ./build.sh

cmake_minimum_required(VERSION 3.10)

project(VoiceChatTest
    VERSION 1.0.0
    DESCRIPTION "ET:Legacy Voice Chat Proof of Concept"
    LANGUAGES C
)

# C standard
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Build type (default to Release)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Compiler flags
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra -Wpedantic")
    set(CMAKE_C_FLAGS_DEBUG "-g -O0 -DDEBUG")
    set(CMAKE_C_FLAGS_RELEASE "-O2 -DNDEBUG")
elseif(MSVC)
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} /W4")
    set(CMAKE_C_FLAGS_DEBUG "/Zi /Od /DDEBUG")
    set(CMAKE_C_FLAGS_RELEASE "/O2 /DNDEBUG")
endif()

# Platform-specific settings
if(WIN32)
    add_definitions(-D_WIN32_WINNT=0x0601)  # Windows 7+
    add_definitions(-DWIN32_LEAN_AND_MEAN)
endif()

#-----------------------------------------------------------------
# Find Dependencies
#-----------------------------------------------------------------

# Find PortAudio
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(PORTAUDIO QUIET portaudio-2.0)
endif()

if(NOT PORTAUDIO_FOUND)
    # Try to find PortAudio manually
    find_path(PORTAUDIO_INCLUDE_DIRS portaudio.h
        PATHS
            /usr/include
            /usr/local/include
            /opt/local/include
            ${PORTAUDIO_ROOT}/include
    )
    find_library(PORTAUDIO_LIBRARIES
        NAMES portaudio portaudio_x64 portaudio_x86
        PATHS
            /usr/lib
            /usr/local/lib
            /opt/local/lib
            ${PORTAUDIO_ROOT}/lib
    )
    if(PORTAUDIO_INCLUDE_DIRS AND PORTAUDIO_LIBRARIES)
        set(PORTAUDIO_FOUND TRUE)
    endif()
endif()

if(NOT PORTAUDIO_FOUND)
    message(FATAL_ERROR
        "PortAudio not found!\n"
        "Install with:\n"
        "  Ubuntu/Debian: sudo apt install libportaudio2 portaudio19-dev\n"
        "  Fedora:        sudo dnf install portaudio portaudio-devel\n"
        "  Arch:          sudo pacman -S portaudio\n"
        "  macOS:         brew install portaudio\n"
        "  Windows:       vcpkg install portaudio"
    )
endif()

message(STATUS "Found PortAudio: ${PORTAUDIO_LIBRARIES}")

# Find Opus
if(PkgConfig_FOUND)
    pkg_check_modules(OPUS QUIET opus)
endif()

if(NOT OPUS_FOUND)
    # Try to find Opus manually
    find_path(OPUS_INCLUDE_DIRS opus/opus.h
        PATHS
            /usr/include
            /usr/local/include
            /opt/local/include
            ${OPUS_ROOT}/include
    )
    find_library(OPUS_LIBRARIES
        NAMES opus libopus
        PATHS
            /usr/lib
            /usr/local/lib
            /opt/local/lib
            ${OPUS_ROOT}/lib
    )
    if(OPUS_INCLUDE_DIRS AND OPUS_LIBRARIES)
        set(OPUS_FOUND TRUE)
    endif()
endif()

if(NOT OPUS_FOUND)
    message(FATAL_ERROR
        "Opus codec not found!\n"
        "Install with:\n"
        "  Ubuntu/Debian: sudo apt install libopus0 libopus-dev\n"
        "  Fedora:        sudo dnf install opus opus-devel\n"
        "  Arch:          sudo pacman -S opus\n"
        "  macOS:         brew install opus\n"
        "  Windows:       vcpkg install opus"
    )
endif()

message(STATUS "Found Opus: ${OPUS_LIBRARIES}")

#-----------------------------------------------------------------
# Voice Client
#-----------------------------------------------------------------

add_executable(voice_client client.c)

target_include_directories(voice_client PRIVATE
    ${PORTAUDIO_INCLUDE_DIRS}
    ${OPUS_INCLUDE_DIRS}
)

target_link_libraries(voice_client PRIVATE
    ${PORTAUDIO_LIBRARIES}
    ${OPUS_LIBRARIES}
)

# Platform-specific libraries
if(WIN32)
    target_link_libraries(voice_client PRIVATE ws2_32)
elseif(UNIX AND NOT APPLE)
    target_link_libraries(voice_client PRIVATE pthread m)
    # PulseAudio support (usually linked by PortAudio)
    find_library(PULSE_LIBRARY pulse)
    find_library(PULSE_SIMPLE_LIBRARY pulse-simple)
    if(PULSE_LIBRARY)
        target_link_libraries(voice_client PRIVATE ${PULSE_LIBRARY})
    endif()
    if(PULSE_SIMPLE_LIBRARY)
        target_link_libraries(voice_client PRIVATE ${PULSE_SIMPLE_LIBRARY})
    endif()
elseif(APPLE)
    find_library(COREAUDIO_FRAMEWORK CoreAudio)
    find_library(AUDIOUNIT_FRAMEWORK AudioUnit)
    find_library(AUDIOTOOLBOX_FRAMEWORK AudioToolbox)
    target_link_libraries(voice_client PRIVATE
        ${COREAUDIO_FRAMEWORK}
        ${AUDIOUNIT_FRAMEWORK}
        ${AUDIOTOOLBOX_FRAMEWORK}
    )
endif()

#-----------------------------------------------------------------
# Voice Server (Echo)
#-----------------------------------------------------------------

add_executable(voice_server server.c)

# Server only needs socket libraries
if(WIN32)
    target_link_libraries(voice_server PRIVATE ws2_32)
elseif(UNIX)
    target_link_libraries(voice_server PRIVATE pthread)
endif()

#-----------------------------------------------------------------
# Installation (optional)
#-----------------------------------------------------------------

install(TARGETS voice_client voice_server
    RUNTIME DESTINATION bin
)

#-----------------------------------------------------------------
# Summary
#-----------------------------------------------------------------

message(STATUS "")
message(STATUS "=== Voice Chat Test Configuration ===")
message(STATUS "Build type:     ${CMAKE_BUILD_TYPE}")
message(STATUS "C Compiler:     ${CMAKE_C_COMPILER}")
message(STATUS "PortAudio:      ${PORTAUDIO_LIBRARIES}")
message(STATUS "Opus:           ${OPUS_LIBRARIES}")
message(STATUS "")
message(STATUS "Build with:")
message(STATUS "  mkdir build && cd build && cmake .. && make")
message(STATUS "")
message(STATUS "Run:")
message(STATUS "  ./voice_server          # Start echo server")
message(STATUS "  ./voice_client          # Start client (hold SPACE to talk)")
message(STATUS "")
