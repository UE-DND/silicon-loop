---
name: silicon-loop
description: Implement, build, verify, flash, and batch-debug STM32 bare-metal firmware in this repository using the existing CMake/toolchain setup, CMSIS, STM32 SPL or other in-repo low-level support, OpenOCD, and non-interactive GDB. Use when Agent needs to modify STM32 firmware, configure clocks/GPIO/UART/timers/interrupts/registers, diagnose build or runtime faults, or complete a write-verify-debug loop without CubeMX or interactive terminal sessions.
---

# Silicon Loop

## Overview

Use this skill as the operating discipline for STM32 bare-metal firmware work.
Implement the change, build it, and debug failures without blocking the terminal.

Assume the runtime repository normally follows this standard layout:

- `core/`
- `drivers/cmsis/`
- `drivers/*/inc/`
- `drivers/*/src/`
- `startup/`
- `linker/`
- `svd/`
- `tools/openocd/`

Do not assume a fixed MCU, board, or SVD file.

## Environment Preflight

Before any firmware work, check the project root for `.siliconloop`.

- If `.siliconloop` exists and shows `status=ready`, treat the environment as ready and continue.
- If `.siliconloop` exists and does not show `status=ready`, treat the environment as incomplete and account for the missing tools in the next steps.
- If `.siliconloop` does not exist, run `node scripts/check_env.mjs` from the project root to generate it, then use the result.

The script checks whether the core local dependencies are available, including:

- `cmake`
- `openocd`
- `arm-none-eabi-gcc`
- `arm-none-eabi-g++`
- `arm-none-eabi-objcopy`
- `arm-none-eabi-size`
- `arm-none-eabi-gdb`

Do not rewrite `.siliconloop` manually unless the task explicitly requires it.

## Project Baseline

- Detect the actual build system and prefer the commands already used by the current project.
- Prefer `cmake --preset <name>` when presets exist. Otherwise use the standard flow such as `cmake -B build` and `cmake --build build`.
- Identify the real MCU family, device macro, startup file, linker script, and debug/flash config from the current project before editing.
- Preserve the existing startup, interrupt vector, linker, memory layout, and toolchain assumptions unless the task explicitly requires changing them.
- If the current project already uses SPL, CMSIS, LL, direct register access, or another in-repo vendor layer, stay consistent with that choice.
- Do not introduce CubeMX output, HAL, or a new framework unless the user explicitly asks for it.

## Identify The Actual Target First

Before making hardware-facing changes, inspect the current project and determine:

- The MCU part number or at least the MCU family and series
- The active compile definitions such as `STM32F10X_MD`, `STM32F4xx`, or board-specific macros
- The startup file actually being built
- The linker script actually being used
- The OpenOCD config or target script actually used for flashing
- Whether the project is board-specific or only MCU-specific

Confirm this from:

- user prompts
- `CMakeLists.txt`, `CMakePresets.json`, toolchain files, and build presets
- `startup/` filenames
- linker script names
- device standard drivers under `drivers/` or similar directories
- `tools/openocd/`, `openocd.cfg`, or project scripts
- any `svd/` directory in the active project

If the current project or user does not clearly identify a board, work from the MCU or MCU series instead of inventing a board model.

Example target signals:

- `startup/startup_stm32f103xb.s`
- `linker/STM32F103XX_FLASH.ld`
- `tools/openocd/stm32f103c8_blue_pill.cfg`
- compile definitions such as `STM32F10X_MD`

Treat those only as clues for that repository, never as a default rule.

## SVD Guidance

SVD stands for CMSIS System View Description.
An SVD file is an XML description of a device's peripherals, registers, addresses, bitfields, access rules, and reset values.

Use SVD when you need exact low-level register facts, especially for:

- direct register programming
- verifying register names, offsets, and bitfields
- checking reset values or access semantics
- exploring an unfamiliar peripheral quickly

SVD is usually unnecessary for:

- pure application logic changes
- build-system-only changes
- edits that stay entirely inside existing SPL or other vendor APIs
- tasks where the exact register layout is already clear from the current device headers and no new register work is being introduced

## Register Access Discipline

Never hallucinate register addresses, offsets, reset values, bit positions, or field names.
Never guess from memory when writing or changing low-level hardware configuration.

When direct register work is required, verify facts in this order:

1. The current project's CMSIS device header and vendor headers
2. A matching SVD file for the actual MCU or MCU series in the active project
3. Existing project code already targeting the same peripheral
4. The user-provided datasheet or reference-manual excerpts, if any

If no matching SVD file for the active target exists, do not run the SVD helper script just because some standard template used an example SVD.
Use the current headers and other verified in-repo sources instead.

Before writing direct register code, confirm all of the following when relevant:

- the exact peripheral instance name
- the exact register name
- the address model, base, or offset being used
- the relevant bitfields and access semantics
- any reset value or default state that affects safe initialization

## Using The SVD Helper

The helper script lives at `scripts/svd_tool.mjs`.
Use it only when both are true:

- the task needs low-level register facts
- you have found an SVD file that matches the actual MCU or MCU series being used by the current project

Look for SVD files in:

- `./svd/`
- another project-local device-support directory
- a path explicitly provided by the user

Always use the file that matches the actual MCU or MCU series in the active repository.

Use this progressive lookup order after selecting the correct SVD file:

1. Build the peripheral map:

```bash
node scripts/svd_tool.mjs --file ./svd/<matching-device>.svd --list-peripherals
```

2. Lock onto one peripheral:

```bash
node scripts/svd_tool.mjs --file ./svd/<matching-device>.svd --peripheral <NAME>
```

3. Inspect one register and its bitfields:

```bash
node scripts/svd_tool.mjs --file ./svd/<matching-device>.svd --peripheral <NAME> --register <REG_NAME>
```

4. Search fuzzily when the name or function is uncertain:

```bash
node scripts/svd_tool.mjs --file ./svd/<matching-device>.svd --search "<query>"
```

5. Return machine-readable data when another script needs structured output:

```bash
node scripts/svd_tool.mjs --file ./svd/<matching-device>.svd --peripheral <NAME> --format json
```

Append `--format json` when structured output is needed.

If `svd_tool.mjs` fails with a `Did you mean:` hint, automatically retry with the suggested name.
Do not stop at the first typo when the tool already provides a recovery path.

## Closed-Loop Workflow

Execute work in this order unless the task explicitly requires another sequence:

1. Read the relevant source, build files, startup code, linker script, and device headers.
2. Identify the actual MCU or MCU series and board assumptions used by the current project.
3. Decide whether SVD lookup is necessary.
4. If needed and only if a matching SVD exists, resolve low-level facts through `svd_tool.mjs`.
5. Implement the firmware change.
6. Build immediately.
7. Fix compile or link failures from stdout before doing anything else.
8. Flash only with a single non-blocking command.
9. Debug runtime faults only with non-interactive commands.

## Build

Use the repository's existing build flow.
Prefer a clean configure step when the build directory does not exist or toolchain settings changed.

Typical commands:

```bash
cmake -B build
cmake --build build
```

If the repository defines presets, prefer:

```bash
cmake --preset <preset-name>
cmake --build --preset <preset-name>
```

When compilation fails, read stdout and stderr, patch the code, and rebuild.
Do not stop after reporting compiler errors.

## Flash

Never leave OpenOCD running in the foreground.
Always use a one-shot command that programs, verifies, resets, and exits.
Always include `exit`.

Use the project's real interface and target config instead of hardcoding one board profile.
If the active project does not define a board config, use the MCU family target script that matches the detected chip.

Template:

```bash
openocd -f <interface.cfg> -f <board-or-target.cfg> -c "program <path-to-elf> verify reset exit"
```

Replace the placeholders with the actual ELF and OpenOCD config discovered from the current project.
If flashing fails, inspect the command output, fix the image path, interface, target, or artifact, and retry with another single-shot command.

## Debug

Never launch interactive GDB.
Never leave the terminal attached to a prompt waiting for manual input.

If a HardFault or other runtime crash occurs, capture the call stack and registers in batch mode.
Use commands such as:

```bash
arm-none-eabi-gdb <path-to-elf> -batch -ex "target extended-remote :3333" -ex "monitor reset halt" -ex "bt" -ex "info registers" -ex "x/16i \$pc" -ex "quit"
```

Adapt the ELF path, transport, and monitor commands to the current project.
If the target is not running under OpenOCD yet, start OpenOCD in a separate non-interactive command that is clearly bounded or short-lived.

## Execution Style

- Prefer non-interactive commands.
- Prefer existing repository scripts over inventing new command flows.
- Verify assumptions from files in the current project before editing.
- Use the standard STM32 project layout as a starting expectation, not as permission to hardcode one chip, one board, or one SVD.
- When the target device, board, or SVD match is unclear and cannot be derived safely from the repository, state that uncertainty briefly and continue with the safest verified path instead of guessing.
