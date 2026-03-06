#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const MAX_SEARCH_LIMIT = 50;
const TEXT_TAGS = {
  device: new Set(["name", "version", "description", "size", "access", "resetValue", "resetMask"]),
  peripheral: new Set(["name", "description", "baseAddress", "size", "access", "resetValue", "resetMask"]),
  register: new Set(["name", "description", "addressOffset", "size", "access", "resetValue", "resetMask", "dim", "dimIncrement"]),
  field: new Set(["name", "description", "bitOffset", "bitWidth", "bitRange", "lsb", "msb", "access"]),
};

class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.suggestions = options.suggestions ?? [];
    this.suggestedCommands = options.suggestedCommands ?? [];
  }
}

main();

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${buildHelpText()}\n`);
      return;
    }

    const model = loadSvdModel(args.file);
    const response = runCommand(args, model);

    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatTextResponse(response)}\n`);
    }
  } catch (error) {
    handleFatalError(error, process.argv.slice(2));
  }
}

function parseArgs(argv) {
  const args = {
    file: null,
    format: "text",
    peripheral: null,
    register: null,
    search: null,
    listPeripherals: false,
    limit: 10,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--list-peripherals") {
      args.listPeripherals = true;
      continue;
    }
    if (token === "--file") {
      args.file = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--format") {
      args.format = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--peripheral") {
      args.peripheral = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--register") {
      args.register = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--search") {
      args.search = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--limit") {
      const rawLimit = readValue(argv, ++index, token);
      const limit = Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new CliError("INVALID_ARGS", `Invalid value for --limit: '${rawLimit}'. Expected a positive integer.`);
      }
      args.limit = Math.min(limit, MAX_SEARCH_LIMIT);
      continue;
    }

    throw new CliError("INVALID_ARGS", `Unknown argument: '${token}'.`, {
      suggestedCommands: ["node svd_tool.mjs --help"],
    });
  }

  if (args.help) {
    return args;
  }
  if (!args.file) {
    throw new CliError("INVALID_ARGS", "Missing required argument: --file <path>.", {
      suggestedCommands: ["node svd_tool.mjs --help"],
    });
  }
  if (!["text", "json"].includes(args.format)) {
    throw new CliError("INVALID_ARGS", `Invalid value for --format: '${args.format}'. Expected 'text' or 'json'.`);
  }

  const selectedModes = [
    args.listPeripherals ? "list" : null,
    args.search ? "search" : null,
    args.peripheral ? (args.register ? "detail" : "inspect") : null,
  ].filter(Boolean);

  if (selectedModes.length === 0) {
    throw new CliError("INVALID_ARGS", "No mode selected. Use --list-peripherals, --peripheral, or --search.", {
      suggestedCommands: ["node svd_tool.mjs --help"],
    });
  }
  if (selectedModes.length > 1) {
    throw new CliError("INVALID_ARGS", "Mode flags are mutually exclusive. Use only one of --list-peripherals, --peripheral, or --search.");
  }
  if (args.register && !args.peripheral) {
    throw new CliError("INVALID_ARGS", "--register requires --peripheral <name>.");
  }

  return args;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new CliError("INVALID_ARGS", `Missing value for ${flag}.`);
  }
  return value;
}

function buildHelpText() {
  return [
    "SVD Node CLI",
    "",
    "Usage:",
    "  node svd_tool.mjs --file <path> --list-peripherals",
    "  node svd_tool.mjs --file <path> --peripheral <name>",
    "  node svd_tool.mjs --file <path> --peripheral <name> --register <name>",
    '  node svd_tool.mjs --file <path> --search "baud rate"',
    "",
    "Options:",
    "  --file <path>           Path to the CMSIS-SVD file.",
    "  --format <text|json>    Output format. Default: text.",
    "  --list-peripherals      List available peripherals.",
    "  --peripheral <name>     Inspect a peripheral.",
    "  --register <name>       Inspect a register within the selected peripheral.",
    "  --search <query>        Search peripherals, registers, and fields.",
    "  --limit <n>             Search result limit. Default: 10. Max: 50.",
    "  --help                  Show this help text.",
  ].join("\n");
}

function loadSvdModel(filePath) {
  const absolutePath = path.resolve(filePath);
  let xmlText;
  try {
    xmlText = fs.readFileSync(absolutePath, "utf8");
  } catch {
    throw new CliError("PARSE_ERROR", `Failed to read SVD file: ${absolutePath}.`);
  }

  const deviceNode = parseSvdXml(xmlText);
  xmlText = null;

  if (!deviceNode || deviceNode.peripherals.length === 0) {
    throw new CliError("PARSE_ERROR", `Invalid SVD structure in file: ${absolutePath}.`);
  }

  return buildModel(deviceNode, absolutePath);
}

function parseSvdXml(xmlText) {
  const tokenRegex = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[\s\S]*?>|<\/?[^>]+>|[^<]+/g;
  const stack = [{ kind: "root", tag: "$root" }];
  let device = null;

  for (const token of xmlText.match(tokenRegex) ?? []) {
    if (!token) {
      continue;
    }
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!DOCTYPE")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      const text = token.slice(9, -3);
      appendText(stack, text);
      continue;
    }
    if (!token.startsWith("<")) {
      appendText(stack, token);
      continue;
    }
    if (token.startsWith("</")) {
      const tag = token.slice(2, -1).trim();
      const entry = stack.pop();
      if (!entry || entry.tag !== tag) {
        throw new CliError("PARSE_ERROR", `Malformed XML: unexpected closing tag </${tag}>.`);
      }

      if (entry.kind === "text") {
        entry.parentNode[entry.tag] = decodeXmlEntities(entry.text);
      } else if (entry.kind === "node" && entry.tag === "device") {
        device = entry.node;
      } else if (entry.kind === "node") {
        entry.parentNode[entry.collection].push(entry.node);
      }
      continue;
    }

    const selfClosing = token.endsWith("/>");
    const inner = token.slice(1, selfClosing ? -2 : -1).trim();
    const { tag, attributes } = parseStartTag(inner);
    const top = stack[stack.length - 1];

    if (top.kind === "skip") {
      stack.push({ kind: "skip", tag });
      if (selfClosing) {
        stack.pop();
      }
      continue;
    }

    if (tag === "device" && top.kind === "root") {
      const entry = { kind: "node", tag, node: { peripherals: [] }, parentNode: null, collection: null };
      stack.push(entry);
      if (selfClosing) {
        stack.pop();
        device = entry.node;
      }
      continue;
    }

    if (tag === "peripherals" && top.kind === "node" && top.tag === "device") {
      stack.push({ kind: "container", tag, parentNode: top.node, collection: "peripherals" });
      if (selfClosing) {
        stack.pop();
      }
      continue;
    }

    if (tag === "registers" && top.kind === "node" && top.tag === "peripheral") {
      stack.push({ kind: "container", tag, parentNode: top.node, collection: "registers" });
      if (selfClosing) {
        stack.pop();
      }
      continue;
    }

    if (tag === "fields" && top.kind === "node" && top.tag === "register") {
      stack.push({ kind: "container", tag, parentNode: top.node, collection: "fields" });
      if (selfClosing) {
        stack.pop();
      }
      continue;
    }

    if (tag === "peripheral" && top.kind === "container" && top.collection === "peripherals") {
      const node = { registers: [], derivedFrom: attributes.derivedFrom ?? null };
      const entry = { kind: "node", tag, node, parentNode: top.parentNode, collection: "peripherals" };
      stack.push(entry);
      if (selfClosing) {
        stack.pop();
        top.parentNode.peripherals.push(node);
      }
      continue;
    }

    if (tag === "register" && top.kind === "container" && top.collection === "registers") {
      const node = { fields: [], derivedFrom: attributes.derivedFrom ?? null };
      const entry = { kind: "node", tag, node, parentNode: top.parentNode, collection: "registers" };
      stack.push(entry);
      if (selfClosing) {
        stack.pop();
        top.parentNode.registers.push(node);
      }
      continue;
    }

    if (tag === "field" && top.kind === "container" && top.collection === "fields") {
      const node = { derivedFrom: attributes.derivedFrom ?? null };
      const entry = { kind: "node", tag, node, parentNode: top.parentNode, collection: "fields" };
      stack.push(entry);
      if (selfClosing) {
        stack.pop();
        top.parentNode.fields.push(node);
      }
      continue;
    }

    if (top.kind === "node" && TEXT_TAGS[top.tag]?.has(tag)) {
      const entry = { kind: "text", tag, text: "", parentNode: top.node };
      stack.push(entry);
      if (selfClosing) {
        stack.pop();
        top.node[tag] = "";
      }
      continue;
    }

    stack.push({ kind: "skip", tag });
    if (selfClosing) {
      stack.pop();
    }
  }

  if (!device) {
    throw new CliError("PARSE_ERROR", "Malformed XML: missing <device> root.");
  }

  return device;
}

function parseStartTag(inner) {
  const firstSpace = inner.search(/\s/);
  const tag = firstSpace === -1 ? inner : inner.slice(0, firstSpace);
  const attributes = {};
  if (firstSpace !== -1) {
    const attrText = inner.slice(firstSpace + 1);
    const attrRegex = /([A-Za-z0-9_:.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    for (const match of attrText.matchAll(attrRegex)) {
      const value = match[3] ?? match[4] ?? "";
      attributes[match[1]] = decodeXmlEntities(value);
    }
  }
  return { tag, attributes };
}

function appendText(stack, text) {
  const top = stack[stack.length - 1];
  if (top?.kind === "text") {
    top.text += text;
  }
}

function decodeXmlEntities(text) {
  return normalizeText(String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10))));
}

function buildModel(deviceNode, filePath) {
  const deviceDefaults = readRegisterDefaults(deviceNode, null);
  const rawPeripheralMap = new Map(deviceNode.peripherals.map((peripheral) => [peripheral.name, peripheral]));
  const peripheralCache = new Map();
  const resolving = new Set();

  function resolvePeripheral(name) {
    if (peripheralCache.has(name)) {
      return peripheralCache.get(name);
    }

    const rawPeripheral = rawPeripheralMap.get(name);
    if (!rawPeripheral) {
      return null;
    }
    if (resolving.has(name)) {
      throw new CliError("PARSE_ERROR", `Circular peripheral inheritance detected for '${name}'.`);
    }

    resolving.add(name);
    const basePeripheral = rawPeripheral.derivedFrom ? resolvePeripheral(rawPeripheral.derivedFrom) : null;
    const peripheralDefaults = readRegisterDefaults(rawPeripheral, basePeripheral?.defaults ?? deviceDefaults);
    const peripheral = {
      name: normalizeText(rawPeripheral.name),
      description: normalizeText(rawPeripheral.description ?? basePeripheral?.description ?? ""),
      baseAddress: parseInteger(rawPeripheral.baseAddress ?? basePeripheral?.baseAddress ?? 0),
      derivedFrom: rawPeripheral.derivedFrom ?? null,
      defaults: peripheralDefaults,
      registers: resolveRegistersForPeripheral(rawPeripheral, basePeripheral, peripheralDefaults),
    };
    peripheral.registerCount = peripheral.registers.length;
    for (const register of peripheral.registers) {
      register.absoluteAddress = peripheral.baseAddress + register.addressOffset;
    }

    peripheralCache.set(name, peripheral);
    resolving.delete(name);
    return peripheral;
  }

  const peripherals = deviceNode.peripherals.map((peripheral) => resolvePeripheral(peripheral.name));
  const peripheralsByName = new Map();
  const searchDocuments = [];

  for (const peripheral of peripherals) {
    peripheralsByName.set(peripheral.name, peripheral);
    searchDocuments.push({
      kind: "peripheral",
      name: peripheral.name,
      peripheral: peripheral.name,
      register: null,
      field: null,
      description: peripheral.description,
      haystackName: peripheral.name,
      haystackDescription: peripheral.description,
      absoluteAddress: peripheral.baseAddress,
    });

    for (const register of peripheral.registers) {
      searchDocuments.push({
        kind: "register",
        name: register.name,
        peripheral: peripheral.name,
        register: register.name,
        field: null,
        description: register.description,
        haystackName: `${peripheral.name} ${register.name}`,
        haystackDescription: register.description,
        absoluteAddress: register.absoluteAddress,
      });

      for (const field of register.fields) {
        searchDocuments.push({
          kind: "field",
          name: field.name,
          peripheral: peripheral.name,
          register: register.name,
          field: field.name,
          description: field.description,
          haystackName: `${peripheral.name} ${register.name} ${field.name}`,
          haystackDescription: field.description,
          absoluteAddress: register.absoluteAddress,
        });
      }
    }
  }

  return {
    device: {
      name: normalizeText(deviceNode.name),
      version: normalizeText(deviceNode.version),
      description: normalizeText(deviceNode.description),
      file: filePath,
    },
    peripherals,
    peripheralsByName,
    searchDocuments,
  };
}

function resolveRegistersForPeripheral(rawPeripheral, basePeripheral, peripheralDefaults) {
  const rawRegisters = rawPeripheral.registers ?? [];
  const baseRegisters = basePeripheral?.registers ?? [];
  const baseRegisterMap = new Map(baseRegisters.map((register) => [register.name, register]));

  if (rawRegisters.length === 0) {
    return baseRegisters.map(cloneRegister);
  }

  const registers = [];
  for (const rawRegister of rawRegisters) {
    const baseRegister = resolveBaseRegister(rawRegister, rawPeripheral, basePeripheral, baseRegisterMap);
    const defaults = readRegisterDefaults(rawRegister, baseRegister?.defaults ?? peripheralDefaults);
    const register = {
      name: normalizeText(rawRegister.name),
      description: normalizeText(rawRegister.description ?? baseRegister?.description ?? ""),
      addressOffset: parseInteger(rawRegister.addressOffset ?? baseRegister?.addressOffset ?? 0),
      absoluteAddress: 0,
      resetValue: parseOptionalInteger(rawRegister.resetValue, baseRegister?.resetValue ?? defaults.resetValue),
      access: normalizeText(rawRegister.access ?? baseRegister?.access ?? defaults.access),
      size: parseOptionalInteger(rawRegister.size, baseRegister?.size ?? defaults.size),
      resetMask: parseOptionalInteger(rawRegister.resetMask, baseRegister?.resetMask ?? defaults.resetMask),
      derivedFrom: rawRegister.derivedFrom ?? null,
      defaults,
      fields: resolveFieldsForRegister(rawRegister, baseRegister, peripheralDefaults),
    };
    register.fieldCount = register.fields.length;
    registers.push(register);
  }

  return registers.sort((left, right) => left.addressOffset - right.addressOffset || left.name.localeCompare(right.name));
}

function resolveBaseRegister(rawRegister, rawPeripheral, basePeripheral, baseRegisterMap) {
  if (!rawRegister.derivedFrom) {
    return baseRegisterMap.get(rawRegister.name) ?? null;
  }

  const parts = rawRegister.derivedFrom.split(".");
  if (parts.length === 1) {
    return baseRegisterMap.get(parts[0]) ?? null;
  }
  if (parts.length === 2) {
    const [peripheralName, registerName] = parts;
    if (peripheralName === rawPeripheral.name) {
      return baseRegisterMap.get(registerName) ?? null;
    }
    if (basePeripheral?.name === peripheralName) {
      return basePeripheral.registers.find((register) => register.name === registerName) ?? null;
    }
  }
  return null;
}

function resolveFieldsForRegister(rawRegister, baseRegister, peripheralDefaults) {
  const rawFields = rawRegister.fields ?? [];
  const baseFields = baseRegister?.fields ?? [];
  const baseFieldMap = new Map(baseFields.map((field) => [field.name, field]));

  if (rawFields.length === 0) {
    return baseFields.map((field) => ({ ...field }));
  }

  const fields = [];
  for (const rawField of rawFields) {
    const baseField = rawField.derivedFrom ? baseFieldMap.get(rawField.derivedFrom) ?? null : baseFieldMap.get(rawField.name) ?? null;
    const bitOffset = parseFieldBitOffset(rawField, baseField);
    const bitWidth = parseFieldBitWidth(rawField, baseField);
    fields.push({
      name: normalizeText(rawField.name),
      description: normalizeText(rawField.description ?? baseField?.description ?? ""),
      bitOffset,
      bitWidth,
      bitRange: formatBitRange(bitOffset, bitWidth),
      access: normalizeText(rawField.access ?? baseField?.access ?? baseRegister?.access ?? peripheralDefaults.access),
    });
  }

  return fields.sort((left, right) => right.bitOffset - left.bitOffset || left.name.localeCompare(right.name));
}

function readRegisterDefaults(node, parentDefaults) {
  return {
    size: parseOptionalInteger(node?.size, parentDefaults?.size ?? null),
    access: normalizeText(node?.access ?? parentDefaults?.access ?? null),
    resetValue: parseOptionalInteger(node?.resetValue, parentDefaults?.resetValue ?? null),
    resetMask: parseOptionalInteger(node?.resetMask, parentDefaults?.resetMask ?? null),
  };
}

function cloneRegister(register) {
  return {
    ...register,
    fields: register.fields.map((field) => ({ ...field })),
    defaults: { ...register.defaults },
  };
}

function parseFieldBitOffset(rawField, baseField) {
  if (rawField.bitOffset !== undefined) {
    return parseInteger(rawField.bitOffset);
  }
  if (rawField.lsb !== undefined) {
    return parseInteger(rawField.lsb);
  }
  if (rawField.bitRange) {
    const match = String(rawField.bitRange).match(/\[(\d+):(\d+)\]/);
    if (match) {
      return Number.parseInt(match[2], 10);
    }
  }
  return baseField?.bitOffset ?? 0;
}

function parseFieldBitWidth(rawField, baseField) {
  if (rawField.bitWidth !== undefined) {
    return parseInteger(rawField.bitWidth);
  }
  if (rawField.msb !== undefined && rawField.lsb !== undefined) {
    return parseInteger(rawField.msb) - parseInteger(rawField.lsb) + 1;
  }
  if (rawField.bitRange) {
    const match = String(rawField.bitRange).match(/\[(\d+):(\d+)\]/);
    if (match) {
      return Number.parseInt(match[1], 10) - Number.parseInt(match[2], 10) + 1;
    }
  }
  return baseField?.bitWidth ?? 1;
}

function runCommand(args, model) {
  if (args.listPeripherals) {
    return buildListResponse(model, args);
  }
  if (args.search) {
    return buildSearchResponse(model, args);
  }
  if (args.peripheral && args.register) {
    return buildDetailResponse(model, args);
  }
  return buildInspectResponse(model, args);
}

function buildListResponse(model, args) {
  const peripherals = model.peripherals
    .map((peripheral) => serializePeripheral(peripheral))
    .sort((left, right) => left.name.localeCompare(right.name));
  const nextPeripheral = peripherals.find((entry) => entry.registerCount > 0)?.name ?? peripherals[0]?.name;
  return {
    ok: true,
    mode: "list",
    device: model.device,
    data: { peripherals },
    hints: {
      next: nextPeripheral ? [`node svd_tool.mjs --file ${path.basename(args.file)} --peripheral ${nextPeripheral}`] : [],
      related: [],
    },
  };
}

function buildInspectResponse(model, args) {
  const peripheral = resolvePeripheralOrThrow(model, args.peripheral, args.file);
  const registers = peripheral.registers.map((register) => serializeRegister(register));
  const suggestedRegister = registers.find((register) => register.name === "CR1")?.name
    ?? registers.find((register) => register.fieldCount > 0)?.name
    ?? registers[0]?.name;

  return {
    ok: true,
    mode: "inspect",
    device: model.device,
    data: {
      peripheral: serializePeripheral(peripheral),
      registers,
    },
    hints: {
      next: suggestedRegister ? [`node svd_tool.mjs --file ${path.basename(args.file)} --peripheral ${peripheral.name} --register ${suggestedRegister}`] : [],
      related: [],
    },
  };
}

function buildDetailResponse(model, args) {
  const peripheral = resolvePeripheralOrThrow(model, args.peripheral, args.file);
  const register = resolveRegisterOrThrow(peripheral, args.register, args.file);
  const searchHint = register.fields[0]?.description || register.fields[0]?.name || register.name;

  return {
    ok: true,
    mode: "detail",
    device: model.device,
    data: {
      peripheral: {
        name: peripheral.name,
        description: peripheral.description,
        baseAddress: formatHex(peripheral.baseAddress, 8),
      },
      register: serializeRegister(register),
      fields: register.fields.map((field) => ({
        name: field.name,
        description: field.description,
        bitOffset: field.bitOffset,
        bitWidth: field.bitWidth,
        bitRange: field.bitRange,
        access: field.access || null,
      })),
    },
    hints: {
      next: searchHint ? [`node svd_tool.mjs --file ${path.basename(args.file)} --search "${escapeDoubleQuotes(searchHint)}"`] : [],
      related: [],
    },
  };
}

function buildSearchResponse(model, args) {
  const results = searchModel(model, args.search, args.limit);
  if (results.length === 0) {
    throw new CliError("SEARCH_NO_RESULTS", `No results found for '${args.search}'.`, {
      suggestedCommands: [
        `node svd_tool.mjs --file ${path.basename(args.file)} --list-peripherals`,
        `node svd_tool.mjs --file ${path.basename(args.file)} --search "${escapeDoubleQuotes(shortenSearchTerm(args.search))}"`,
      ],
    });
  }

  const firstResult = results[0];
  return {
    ok: true,
    mode: "search",
    device: model.device,
    data: {
      query: args.search,
      results,
    },
    hints: {
      next: [buildCommandForResult(path.basename(args.file), firstResult)],
      related: [],
    },
  };
}

function searchModel(model, query, limit) {
  const normalizedQuery = normalizeKey(query);
  const queryTerms = normalizeText(query).toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  for (const document of model.searchDocuments) {
    const score = scoreDocument(document, query, normalizedQuery, queryTerms);
    if (score <= 0) {
      continue;
    }
    results.push({
      kind: document.kind,
      peripheral: document.peripheral,
      register: document.register,
      field: document.field,
      description: document.description,
      score,
      absoluteAddress: document.absoluteAddress !== undefined ? formatHex(document.absoluteAddress, 8) : null,
    });
  }

  return results
    .sort((left, right) => right.score - left.score
      || compareNullable(left.peripheral, right.peripheral)
      || compareNullable(left.register, right.register)
      || compareNullable(left.field, right.field))
    .slice(0, limit);
}

function scoreDocument(document, rawQuery, normalizedQuery, queryTerms) {
  const rawName = document.name || "";
  const normalizedName = normalizeKey(rawName);
  const normalizedDescription = normalizeKey(document.description || "");
  const nameTokens = tokenizeForSearch(document.haystackName);
  const descriptionTokens = tokenizeForSearch(document.haystackDescription);
  let score = 0;

  if (rawName === rawQuery) {
    score += 500;
  }
  if (rawName.toLowerCase() === rawQuery.toLowerCase()) {
    score += 450;
  }
  if (normalizedName.includes(normalizedQuery)) {
    score += 200;
  }
  if (normalizedDescription.includes(normalizedQuery)) {
    score += 160;
  }
  if (normalizedName.startsWith(normalizedQuery)) {
    score += 50;
  }
  if (normalizedDescription.startsWith(normalizedQuery)) {
    score += 40;
  }

  const termHits = queryTerms.reduce((count, term) => {
    if (nameTokens.has(term) || descriptionTokens.has(term)) {
      return count + 1;
    }
    return count;
  }, 0);
  score += termHits * 45;

  if (queryTerms.length === 1 && normalizedQuery.length <= 10) {
    const similarity = similarityScore(normalizedQuery, normalizedName);
    if (similarity >= 0.72) {
      score += Math.round(similarity * 80);
    }
  }

  if (score > 0) {
    if (document.kind === "register") {
      score += 20;
    } else if (document.kind === "field") {
      score += 10;
    }
  }

  return score;
}

function resolvePeripheralOrThrow(model, peripheralName, filePath) {
  const peripheral = model.peripheralsByName.get(peripheralName);
  if (peripheral) {
    return peripheral;
  }

  const suggestions = findSuggestions(peripheralName, model.peripherals.map((entry) => entry.name));
  throw new CliError("PERIPHERAL_NOT_FOUND", `Peripheral '${peripheralName}' not found.`, {
    suggestions,
    suggestedCommands: [`node svd_tool.mjs --file ${path.basename(filePath)} --list-peripherals`],
  });
}

function resolveRegisterOrThrow(peripheral, registerName, filePath) {
  const register = peripheral.registers.find((entry) => entry.name === registerName);
  if (register) {
    return register;
  }

  const suggestions = findSuggestions(registerName, peripheral.registers.map((entry) => entry.name));
  throw new CliError("REGISTER_NOT_FOUND", `Register '${registerName}' not found in peripheral '${peripheral.name}'.`, {
    suggestions,
    suggestedCommands: [`node svd_tool.mjs --file ${path.basename(filePath)} --peripheral ${peripheral.name}`],
  });
}

function serializePeripheral(peripheral) {
  return {
    name: peripheral.name,
    description: peripheral.description || "",
    baseAddress: formatHex(peripheral.baseAddress, 8),
    derivedFrom: peripheral.derivedFrom,
    registerCount: peripheral.registerCount,
  };
}

function serializeRegister(register) {
  return {
    name: register.name,
    description: register.description || "",
    addressOffset: formatHex(register.addressOffset, 2),
    absoluteAddress: formatHex(register.absoluteAddress, 8),
    resetValue: register.resetValue === null || register.resetValue === undefined ? null : formatResetValue(register.resetValue, register.size),
    access: register.access || null,
    fieldCount: register.fieldCount,
  };
}

function formatTextResponse(response) {
  if (response.mode === "list") {
    return formatListText(response);
  }
  if (response.mode === "inspect") {
    return formatInspectText(response);
  }
  if (response.mode === "detail") {
    return formatDetailText(response);
  }
  if (response.mode === "search") {
    return formatSearchText(response);
  }
  throw new CliError("PARSE_ERROR", `Unsupported response mode '${response.mode}'.`);
}

function formatListText(response) {
  const lines = ["Available Peripherals:"];
  for (const peripheral of response.data.peripherals) {
    lines.push(`- ${peripheral.name} (${peripheral.baseAddress}): ${peripheral.description || "No description available"}`);
  }
  if (response.hints.next[0]) {
    lines.push("");
    lines.push(`Hint: Run \`${response.hints.next[0]}\` to inspect its registers.`);
  }
  return lines.join("\n");
}

function formatInspectText(response) {
  const { peripheral, registers } = response.data;
  const lines = [
    `Peripheral: ${peripheral.name} (Base Address: ${peripheral.baseAddress})`,
    `Description: ${peripheral.description || "No description available"}`,
    "",
    "Registers:",
  ];
  for (const register of registers) {
    lines.push(`- ${register.name} (${register.addressOffset}): ${register.description || "No description available"}`);
  }
  if (response.hints.next[0]) {
    lines.push("");
    lines.push(`Hint: Run \`${response.hints.next[0]}\` for bitfield details.`);
  }
  return lines.join("\n");
}

function formatDetailText(response) {
  const { peripheral, register, fields } = response.data;
  const lines = [
    `Register: ${peripheral.name}->${register.name}`,
    `Address: ${register.absoluteAddress}`,
    `Reset Value: ${register.resetValue ?? "Unknown"}`,
    `Access: ${register.access ?? "Unknown"}`,
    "",
    "Bitfields:",
  ];
  for (const field of fields) {
    lines.push(`- ${field.bitRange} ${field.name}: ${field.description || "No description available"}`);
  }
  if (response.hints.next[0]) {
    lines.push("");
    lines.push(`Hint: Run \`${response.hints.next[0]}\` to find related registers or fields.`);
  }
  return lines.join("\n");
}

function formatSearchText(response) {
  const lines = [`Search Results for "${response.data.query}":`];
  response.data.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${formatSearchResult(result)}`);
  });
  if (response.hints.next[0]) {
    lines.push("");
    lines.push(`Hint: Run \`${response.hints.next[0]}\` to inspect a result.`);
  }
  return lines.join("\n");
}

function formatSearchResult(result) {
  if (result.kind === "peripheral") {
    return `${result.peripheral}: ${result.description || "No description available"}`;
  }
  if (result.kind === "register") {
    return `${result.peripheral}->${result.register}: ${result.description || "No description available"}`;
  }
  return `${result.peripheral}->${result.register}->${result.field}: ${result.description || "No description available"}`;
}

function handleFatalError(error, argv) {
  const format = detectRequestedFormat(argv);
  if (error instanceof CliError) {
    if (format === "json") {
      process.stderr.write(`${error.message}\n`);
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          suggestions: error.suggestions,
          suggestedCommands: error.suggestedCommands,
        },
      }, null, 2)}\n`);
    } else {
      const lines = [`Error: ${error.message}`];
      if (error.suggestions.length > 0) {
        lines.push(`Did you mean: ${error.suggestions.map((item) => `'${item}'`).join(", ")}?`);
      }
      for (const command of error.suggestedCommands) {
        if (error.code === "PERIPHERAL_NOT_FOUND") {
          lines.push(`Run \`${command}\` to see all available options.`);
        } else if (error.code === "REGISTER_NOT_FOUND") {
          lines.push(`Run \`${command}\` to see all available registers.`);
        } else {
          lines.push(`Try \`${command}\`.`);
        }
      }
      process.stderr.write(`${lines.join("\n")}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}

function detectRequestedFormat(argv) {
  const index = argv.indexOf("--format");
  return index !== -1 && argv[index + 1] === "json" ? "json" : "text";
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeForSearch(value) {
  return new Set(normalizeText(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function parseInteger(value) {
  if (typeof value === "number") {
    return value;
  }
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return 0;
  }
  if (text.startsWith("0x")) {
    return Number.parseInt(text.slice(2), 16);
  }
  if (text.startsWith("#")) {
    return Number.parseInt(text.slice(1).replace(/x/g, "0"), 2);
  }
  if (text === "true") {
    return 1;
  }
  if (text === "false") {
    return 0;
  }
  return Number.parseInt(text, 10);
}

function parseOptionalInteger(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return parseInteger(value);
}

function formatHex(value, minWidth = 0) {
  const safeValue = Number(value ?? 0);
  const hex = safeValue.toString(16).toUpperCase();
  return `0x${hex.padStart(Math.max(minWidth, hex.length), "0")}`;
}

function formatResetValue(value, size) {
  const digits = size && value > 0xFFFF ? Math.max(1, Math.ceil(size / 4)) : value <= 0xFFFF ? 4 : 8;
  return formatHex(value, digits);
}

function formatBitRange(bitOffset, bitWidth) {
  if (bitWidth <= 1) {
    return `[${bitOffset}]`;
  }
  return `[${bitOffset + bitWidth - 1}:${bitOffset}]`;
}

function compareNullable(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function findSuggestions(input, candidates) {
  const normalizedInput = normalizeKey(input);
  return candidates
    .map((candidate) => ({ candidate, score: suggestionScore(normalizedInput, normalizeKey(candidate)) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

function suggestionScore(input, candidate) {
  if (!input || !candidate) {
    return 0;
  }
  if (candidate === input) {
    return 1000;
  }
  if (candidate.startsWith(input) || input.startsWith(candidate)) {
    return 800;
  }
  if (candidate.includes(input) || input.includes(candidate)) {
    return 650;
  }
  const similarity = similarityScore(input, candidate);
  if (similarity < 0.34) {
    return 0;
  }
  return Math.round(similarity * 600);
}

function similarityScore(left, right) {
  const distance = damerauLevenshtein(left, right);
  const longest = Math.max(left.length, right.length, 1);
  return 1 - distance / longest;
}

function damerauLevenshtein(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    table[row][0] = row;
  }
  for (let col = 0; col < cols; col += 1) {
    table[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      table[row][col] = Math.min(
        table[row - 1][col] + 1,
        table[row][col - 1] + 1,
        table[row - 1][col - 1] + cost,
      );
      if (
        row > 1
        && col > 1
        && left[row - 1] === right[col - 2]
        && left[row - 2] === right[col - 1]
      ) {
        table[row][col] = Math.min(table[row][col], table[row - 2][col - 2] + 1);
      }
    }
  }

  return table[rows - 1][cols - 1];
}

function buildCommandForResult(fileName, result) {
  if (result.kind === "peripheral") {
    return `node svd_tool.mjs --file ${fileName} --peripheral ${result.peripheral}`;
  }
  return `node svd_tool.mjs --file ${fileName} --peripheral ${result.peripheral} --register ${result.register}`;
}

function escapeDoubleQuotes(value) {
  return String(value).replace(/"/g, '\\"');
}

function shortenSearchTerm(term) {
  const parts = term.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return term;
  }
  const shortened = parts.slice(0, 2).join(" ");
  return shortened === term ? parts[0] : shortened;
}
