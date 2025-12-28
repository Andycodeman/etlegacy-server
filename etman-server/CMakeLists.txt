cmake_minimum_required(VERSION 3.10)
project(etman_server C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Find required packages
find_package(PkgConfig REQUIRED)
pkg_check_modules(OPUS REQUIRED opus)
pkg_check_modules(LIBPQ REQUIRED libpq)
pkg_check_modules(UUID REQUIRED uuid)

# minimp3 is header-only - just add include path
set(MINIMP3_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/../src/libs/minimp3")

# Platform-specific settings
if(WIN32)
    set(PLATFORM_LIBS ws2_32)
else()
    set(PLATFORM_LIBS m)
endif()

# ETMan Server executable (voice + sounds + admin)
add_executable(etman_server
    main.c
    sound_manager.c
    db_manager.c
    admin/admin.c
    admin/commands.c
)

target_include_directories(etman_server PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${OPUS_INCLUDE_DIRS}
    ${LIBPQ_INCLUDE_DIRS}
    ${UUID_INCLUDE_DIRS}
    ${MINIMP3_INCLUDE}
)

target_link_libraries(etman_server
    ${OPUS_LIBRARIES}
    ${LIBPQ_LIBRARIES}
    ${UUID_LIBRARIES}
    ${PLATFORM_LIBS}
)

# Installation
install(TARGETS etman_server DESTINATION bin)
