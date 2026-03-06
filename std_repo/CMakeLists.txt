cmake_minimum_required(VERSION 3.22)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug)
endif()

set(CMAKE_PROJECT_NAME TEST_ENV_STD)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(${CMAKE_PROJECT_NAME} C ASM)
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")

file(GLOB_RECURSE USER_SOURCES "core/src/*.c")
file(GLOB_RECURSE FW_SOURCES "drivers/STM32F10x_StdPeriph_Driver/src/*.c")
file(GLOB_RECURSE CMSIS_SOURCES "drivers/cmsis/*.c")

set(STARTUP_SCRIPT "startup/startup_stm32f103xb.s")

add_executable(${CMAKE_PROJECT_NAME}
    ${USER_SOURCES}
    ${FW_SOURCES}
    ${CMSIS_SOURCES}
    ${STARTUP_SCRIPT}
)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    core/inc
    drivers/cmsis
    drivers/STM32F10x_StdPeriph_Driver/inc
)

target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE
    USE_STDPERIPH_DRIVER
    STM32F10X_MD
)

set(LINKER_SCRIPT ${CMAKE_CURRENT_SOURCE_DIR}/linker/STM32F103XX_FLASH.ld)

target_compile_options(${CMAKE_PROJECT_NAME} PRIVATE
    -ffunction-sections
    -fdata-sections
)

target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
    -T${LINKER_SCRIPT}
    -specs=nosys.specs
    -Wl,-Map=${CMAKE_PROJECT_NAME}.map
    -Wl,--gc-sections
)

list(REMOVE_ITEM CMAKE_C_IMPLICIT_LINK_LIBRARIES ob)