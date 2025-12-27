cmake_minimum_required(VERSION 3.10)
project(voice_server C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Find required packages
find_package(PkgConfig REQUIRED)
pkg_check_modules(OPUS REQUIRED opus)

# minimp3 is header-only - just add include path
set(MINIMP3_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/../src/libs/minimp3")

# Platform-specific settings
if(WIN32)
    set(PLATFORM_LIBS ws2_32)
else()
    set(PLATFORM_LIBS m)
endif()

# Voice Server executable
add_executable(voice_server
    main.c
    sound_manager.c
)

target_include_directories(voice_server PRIVATE
    ${OPUS_INCLUDE_DIRS}
    ${MINIMP3_INCLUDE}
)

target_link_libraries(voice_server
    ${OPUS_LIBRARIES}
    ${PLATFORM_LIBS}
)

# Installation
install(TARGETS voice_server DESTINATION bin)
