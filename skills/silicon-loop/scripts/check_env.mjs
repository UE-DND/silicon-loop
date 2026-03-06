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

function commandPathOnPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || null;
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

function cmakePath() {
  const fromPath = commandPathOnPath("cmake");
  if (fromPath) return fromPath;

  for (const candidate of clionCmakeCandidates()) {
    if (canExecute(candidate)) return candidate;
  }

  return null;
}

function toolPath(command) {
  return commandPathOnPath(command);
}

const checks = [
  { name: "cmake", path: cmakePath() },
  { name: "openocd", path: toolPath("openocd") },
  { name: "arm-none-eabi-gcc", path: toolPath("arm-none-eabi-gcc") },
  { name: "arm-none-eabi-g++", path: toolPath("arm-none-eabi-g++") },
  { name: "arm-none-eabi-objcopy", path: toolPath("arm-none-eabi-objcopy") },
  { name: "arm-none-eabi-size", path: toolPath("arm-none-eabi-size") },
  { name: "arm-none-eabi-gdb", path: toolPath("arm-none-eabi-gdb") },
];

const missing = checks.filter((check) => !check.path).map((check) => check.name);
const ready = missing.length === 0;
const summary = ready ? "environment ready" : `missing: ${missing.join(" ")}`;
const result = ready ? "ready" : `missing: ${missing.join(" ")}`;

const statusLines = [
  `status=${ready ? "ready" : "missing"}`,
  `summary=${summary}`,
  ...checks.map((check) => `tool.${check.name}=${check.path ?? "missing"}`),
];

fs.writeFileSync(statusFile, `${statusLines.join("\n")}\n`, "utf8");

process.stdout.write(`${result}\n`);
for (const check of checks) {
  process.stdout.write(`${check.name}=${check.path ?? "missing"}\n`);
}
