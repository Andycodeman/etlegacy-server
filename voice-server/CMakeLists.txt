cmake_minimum_required(VERSION 3.10)
project(voice_server C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Platform-specific settings
if(WIN32)
    set(PLATFORM_LIBS ws2_32)
else()
    set(PLATFORM_LIBS "")
endif()

# Voice Server executable
add_executable(voice_server main.c)
target_link_libraries(voice_server ${PLATFORM_LIBS})

# Installation
install(TARGETS voice_server DESTINATION bin)
