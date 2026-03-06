#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
const statusFile = path.join(projectRoot, ".siliconloop");

function commandExistsOnPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { stdio: "ignore" });
  return result.status === 0;
}

function canExecute(filePath, args = ["--version"]) {
  if (!filePath) return false;
  if (!fs.existsSync(filePath)) return false;
  const result = spawnSync(filePath, args, { stdio: "ignore" });
  return result.status === 0;
}

function clionCmakeCandidates() {
  const candidates = [];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/CLion.app/Contents/bin/cmake/mac/aarch64/bin/cmake",
      "/Applications/CLion.app/Contents/bin/cmake/mac/x86_64/bin/cmake"
    );
  }

  if (process.platform === "linux") {
    candidates.push(
      "/opt/clion/bin/cmake/linux/x64/bin/cmake",
      "/snap/clion/current/bin/cmake/linux/x64/bin/cmake"
    );
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
    ].filter(Boolean);

    for (const root of roots) {
      if (!root) continue;
      const localClion = path.join(root, "Programs", "CLion", "bin", "cmake", "win", "x64", "bin", "cmake.exe");
      candidates.push(localClion);
    }

    for (const root of roots) {
      if (!root) continue;
      const jetbrainsDir = path.join(root, "JetBrains");
      if (!fs.existsSync(jetbrainsDir)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(jetbrainsDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().startsWith("clion")) continue;
        candidates.push(
          path.join(jetbrainsDir, entry.name, "bin", "cmake", "win", "x64", "bin", "cmake.exe")
        );
      }
    }
  }

  if (process.env.CLION_CMAKE_PATH) candidates.push(process.env.CLION_CMAKE_PATH);
  if (process.env.CMAKE_PATH) candidates.push(process.env.CMAKE_PATH);

  return [...new Set(candidates)];
}

function cmakeAvailable() {
  if (commandExistsOnPath("cmake")) return true;
  for (const candidate of clionCmakeCandidates()) {
    if (canExecute(candidate)) return true;
  }
  return false;
}

function toolAvailable(command) {
  return commandExistsOnPath(command);
}

const checks = [
  { name: "cmake", ok: cmakeAvailable() },
  { name: "openocd", ok: toolAvailable("openocd") },
  { name: "arm-none-eabi-gcc", ok: toolAvailable("arm-none-eabi-gcc") },
  { name: "arm-none-eabi-g++", ok: toolAvailable("arm-none-eabi-g++") },
  { name: "arm-none-eabi-objcopy", ok: toolAvailable("arm-none-eabi-objcopy") },
  { name: "arm-none-eabi-size", ok: toolAvailable("arm-none-eabi-size") },
  { name: "arm-none-eabi-gdb", ok: toolAvailable("arm-none-eabi-gdb") },
];

const missing = checks.filter((check) => !check.ok).map((check) => check.name);
const ready = missing.length === 0;
const summary = ready ? "environment ready" : `missing: ${missing.join(" ")}`;
const result = ready ? "ready" : `missing: ${missing.join(" ")}`;

fs.writeFileSync(statusFile, `status=${ready ? "ready" : "missing"}\nsummary=${summary}\n`, "utf8");
process.stdout.write(`${result}\n`);
