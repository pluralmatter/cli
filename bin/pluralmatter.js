#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runChat } from "./chat.js";
import { readMessage } from "./read-message.js";
import { readSecret } from "./read-secret.js";

const DEFAULT_BASE_URL = "https://api.pluralmatter.com";
const CLI_VERSION = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const CONFIG_KEYS = {
  apikey: "apiKey",
  "api-key": "apiKey",
  mindid: "mindId",
  "mind-id": "mindId",
  promptid: "promptId",
  "prompt-id": "promptId",
  actor: "actorId",
  "actor-id": "actorId",
  provider: "provider",
  model: "model",
  url: "baseUrl",
  "base-url": "baseUrl",
};
const DISPLAY_KEYS = {
  apiKey: "api-key",
  mindId: "mind-id",
  promptId: "prompt-id",
  actorId: "actor-id",
  provider: "provider",
  model: "model",
  baseUrl: "base-url",
};
const DIAGNOSTIC_HEADERS = [
  "x-mind-request-id",
  "x-mind-recall-items",
  "x-mind-update-status",
  "x-mind-update-pending-count",
  "request-id",
  "retry-after",
];

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (command === "--version" || command === "-V") {
    console.log(CLI_VERSION);
    return;
  }

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    printHelp();
    return;
  }
  if (command === "config") return handleConfig(args);

  const config = await readConfig();
  if (command === "login") return login(args, config);
  if (command === "logout") return logout(args, config);
  if (command === "mind") return handleMind(args, config);
  if (command === "health") return health(args, config);
  if (command === "send") return send(args, config);
  if (command === "chat") return chat(args, config);
  if (command === "status") return status(args, config);
  if (command === "contemplate") return contemplate(args, config);
  fail(`Unknown command: ${command}`);
}

async function handleConfig(args) {
  const action = args.shift();
  if (action === "path") {
    console.log(configPath());
    return;
  }
  if (action === "list") {
    const config = await readConfig();
    for (const [key, value] of Object.entries(config)) {
      const shown = key === "apiKey" ? redact(value) : value;
      console.log(`${DISPLAY_KEYS[key]}=${shown}`);
    }
    return;
  }
  if (action !== "set" && action !== "unset") {
    fail("Use `config set`, `config unset`, `config list`, or `config path`.");
  }

  const inputKey = args.shift()?.toLowerCase();
  const key = CONFIG_KEYS[inputKey];
  if (!key) fail(`Unknown config key: ${inputKey || "(missing)"}`);
  const config = await readConfig();

  if (action === "unset") {
    if (args.length) fail("config unset takes only a key.");
    delete config[key];
  } else {
    const value = args.join(" ").trim();
    if (!value) fail(`A value is required for ${inputKey}.`);
    if (key === "provider") validateProvider(value);
    config[key] = key === "baseUrl" ? value.replace(/\/$/, "") : value;
  }
  await writeConfig(config);
  console.log(`${DISPLAY_KEYS[key]} ${action === "set" ? "saved" : "removed"}`);
}

async function login(args, config) {
  const options = parseLoginFlags(args, config);
  if (!options.apiKey) {
    if (process.stdin.isTTY) {
      console.log(
        "Create a project API key at https://platform.pluralmatter.com",
      );
      console.log("Paste it below. Input is hidden.\n");
    }
    options.apiKey = await readSecret();
  }
  if (!options.apiKey)
    fail(
      "An API key is required. Create one at https://platform.pluralmatter.com.",
    );

  const minds = await authenticatedJson(
    await fetch(`${options.baseUrl}/v1/minds`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
    }),
  );
  if (!Array.isArray(minds))
    throw new Error("The API returned an invalid mind list.");

  config.apiKey = options.apiKey;
  config.baseUrl = options.baseUrl;
  const activeMinds = minds.filter((mind) => mind?.status === "active");
  if (!activeMinds.some((mind) => mind.id === config.mindId)) {
    if (activeMinds[0]?.id) config.mindId = activeMinds[0].id;
    else delete config.mindId;
  }
  await writeConfig(config);

  console.log("Logged in. Credentials saved with owner-only permissions.");
  if (config.mindId) console.log(`Default mind: ${config.mindId}`);
  else console.log("No minds yet. Create one with `pluralmatter mind create`.");
}

async function logout(args, config) {
  if (args.length) fail("logout does not accept arguments.");
  delete config.apiKey;
  delete config.mindId;
  await writeConfig(config);
  console.log(
    "Logged out. Saved credentials and the default mind were removed.",
  );
  if (process.env.MIND_API_KEY || process.env.MIND_ID)
    console.log("Environment overrides are still active in this shell.");
}

async function handleMind(args, config) {
  const action = args.shift();
  if (action === "create") return createMind(args, config);
  if (action === "list") return listMinds(args, config);
  if (action === "use") return useMind(args, config);
  if (action === "inspect") return inspectMind(args, config);
  fail("Use `mind create`, `mind list`, `mind use`, or `mind inspect`.");
}

async function createMind(args, config) {
  const nameParts = [];
  while (args.length && !args[0].startsWith("--")) nameParts.push(args.shift());
  const options = parseMindFlags(args, config, { recallScope: true });
  let name = nameParts.join(" ").trim();
  if (!name && process.stdin.isTTY)
    name = await readMessage(
      process.stdin,
      process.stdout,
      "Mind name (My mind): ",
    );
  name ||= "My mind";

  const mind = await authenticatedJson(
    await fetch(`${options.baseUrl}/v1/minds`, {
      method: "POST",
      headers: apiHeaders(options.apiKey),
      body: JSON.stringify({
        name,
        ...(options.recallScope ? { recall_scope: options.recallScope } : {}),
      }),
    }),
  );
  if (typeof mind?.id !== "string")
    throw new Error("The API did not return a mind ID.");
  config.mindId = mind.id;
  await writeConfig(config);
  if (options.json) console.log(JSON.stringify(mind, null, 2));
  else {
    console.log(`Created mind “${mind.name}” (${mind.id}).`);
    console.log("It is now the default for send and chat.");
  }
}

async function listMinds(args, config) {
  const options = parseMindFlags(args, config);
  const minds = await authenticatedJson(
    await fetch(`${options.baseUrl}/v1/minds`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
    }),
  );
  if (!Array.isArray(minds))
    throw new Error("The API returned an invalid mind list.");
  if (options.json) {
    console.log(JSON.stringify(minds, null, 2));
    return;
  }
  if (!minds.length) {
    console.log("No minds yet. Create one with `pluralmatter mind create`.");
    return;
  }
  const defaultMindId = process.env.MIND_ID || config.mindId;
  const nameWidth = Math.min(
    32,
    Math.max(4, ...minds.map((mind) => String(mind.name || "Mind").length)),
  );
  for (const mind of minds) {
    const marker = mind.id === defaultMindId ? "*" : " ";
    const name = String(mind.name || "Mind")
      .slice(0, nameWidth)
      .padEnd(nameWidth);
    console.log(
      `${marker} ${name}  ${mind.id}  ${mind.recall_scope || "actor"}  ${mind.status}`,
    );
  }
  console.log("\n* default mind");
}

async function useMind(args, config) {
  const id = args.shift();
  if (!id || id.startsWith("--")) fail("Provide a mind ID to use.");
  const options = parseMindFlags(args, config);
  const mind = await fetchMind(id, options);
  if (mind.status !== "active")
    throw new Error("Only an active mind can be selected.");
  config.mindId = mind.id;
  await writeConfig(config);
  console.log(`Default mind set to “${mind.name}” (${mind.id}).`);
}

async function inspectMind(args, config) {
  let id = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const options = parseMindFlags(args, config);
  id ||= process.env.MIND_ID || config.mindId;
  if (!id)
    fail("Select a mind with `pluralmatter mind use <id>` or pass its ID.");
  const mind = await fetchMind(id, options);
  if (options.json) {
    console.log(JSON.stringify(mind, null, 2));
    return;
  }
  console.log(`Name: ${mind.name}`);
  console.log(`ID: ${mind.id}`);
  console.log(`Status: ${mind.status}`);
  console.log(`Recall scope: ${mind.recall_scope}`);
  console.log(`Contemplation: ${mind.contemplation_level}`);
  console.log(`Created: ${mind.created_at}`);
}

async function fetchMind(id, options) {
  return authenticatedJson(
    await fetch(`${options.baseUrl}/v1/minds/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
    }),
  );
}

async function health(args, config) {
  const options = parseRequestFlags(args, config);
  const response = await fetch(`${options.baseUrl}/health`);
  await printJsonOrText(response);
  if (!response.ok) process.exitCode = 1;
}

async function send(args, config) {
  const promptParts = [];
  while (args.length && !args[0].startsWith("--"))
    promptParts.push(args.shift());
  const options = parseRequestFlags(args, config);
  let prompt = promptParts.join(" ").trim();
  if (!prompt) prompt = await readMessage();
  if (!prompt)
    fail("Enter a message, pass one as an argument, or pipe it on stdin.");
  if (!options.apiKey) fail("Log in first with `pluralmatter login`.");
  if (!options.mindId)
    fail(
      "Create or select a mind with `pluralmatter mind create` or `mind use`.",
    );
  const actorToken = await issueActorToken(options);

  const response = await fetch(`${options.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      "x-mind-actor-token": actorToken,
    },
    body: JSON.stringify({
      mind_id: options.mindId,
      ...(options.promptId ? { prompt_id: options.promptId } : {}),
      actor_id: options.actorId,
      idempotency_key: randomUUID(),
      ...(options.occurredAt ? { occurred_at: options.occurredAt } : {}),
      model: options.model,
      ...(options.provider ? { provider: options.provider } : {}),
      max_tokens: options.maxTokens,
      stream: options.stream,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  printDiagnostics(response);
  if (options.stream && response.body) {
    for await (const chunk of response.body) process.stdout.write(chunk);
  } else if (options.json || !response.ok) {
    await printJsonOrText(response);
  } else {
    const body = await response.json();
    const text = Array.isArray(body.content)
      ? body.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
      : "";
    console.log(text || JSON.stringify(body, null, 2));
  }
  if (!response.ok) process.exitCode = 1;
}

async function chat(args, config) {
  const options = parseChatFlags(args, config);
  if (!options.apiKey) fail("Log in first with `pluralmatter login`.");
  if (!options.mindId)
    fail(
      "Create or select a mind with `pluralmatter mind create` or `mind use`.",
    );
  const actorToken = await issueActorToken(options);
  await runChat(options, actorToken);
}

async function status(args, config) {
  const requestId = args.shift();
  if (!requestId || requestId.startsWith("--"))
    fail(
      "Provide the request ID printed by `pluralmatter send` or chat --verbose.",
    );
  const options = parseStatusFlags(args, config);
  if (!options.apiKey) fail("Log in first with `pluralmatter login`.");

  const deadline = Date.now() + options.timeoutMs;
  let body;
  do {
    const response = await fetch(
      `${options.baseUrl}/v1/requests/${encodeURIComponent(requestId)}`,
      { headers: { authorization: `Bearer ${options.apiKey}` } },
    );
    if (!response.ok) {
      await printJsonOrText(response);
      process.exitCode = 1;
      return;
    }
    body = await response.json();
    if (!options.wait || body.status !== "processing") break;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const retryAfterMs = positiveNumber(body.retry_after_ms) ?? 1_000;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryAfterMs, remainingMs)),
    );
  } while (Date.now() <= deadline);

  console.log(JSON.stringify(body, null, 2));
  if (options.wait && body.status === "processing") {
    console.error(
      `Mind update is still processing after ${options.timeoutMs}ms.`,
    );
    process.exitCode = 1;
  }
}

async function contemplate(args, config) {
  const options = parseRequestFlags(args, config);
  if (!options.apiKey) fail("Log in first with `pluralmatter login`.");
  if (!options.mindId)
    fail(
      "Create or select a mind with `pluralmatter mind create` or `mind use`.",
    );
  const actorToken = await issueActorToken(options);
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
    "x-mind-actor-token": actorToken,
  };
  const accepted = await fetch(
    `${options.baseUrl}/v1/minds/${options.mindId}/contemplate`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ actor_id: options.actorId }),
    },
  );
  if (!accepted.ok) {
    await printJsonOrText(accepted);
    process.exitCode = 1;
    return;
  }
  let operation = await accepted.json();
  const deadline = Date.now() + 60_000;
  while (
    operation.status !== "completed" &&
    operation.status !== "failed" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await fetch(
      `${options.baseUrl}/v1/minds/${options.mindId}/contemplate/${operation.operation_id}`,
      { headers },
    );
    if (!status.ok) {
      await printJsonOrText(status);
      process.exitCode = 1;
      return;
    }
    operation = await status.json();
  }
  console.log(JSON.stringify(operation, null, 2));
  if (operation.status !== "completed") process.exitCode = 1;
}

async function issueActorToken(options) {
  const response = await fetch(`${options.baseUrl}/v1/actor-tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mind_id: options.mindId,
      actor_id: options.actorId,
    }),
  });
  const body = await response.json();
  if (!response.ok || typeof body.actor_token !== "string")
    fail(
      `${response.status}: ${body?.error?.message || "Actor token could not be issued."}`,
    );
  return body.actor_token;
}

function parseRequestFlags(args, config, additionalBooleanFlags = new Set()) {
  const options = {
    baseUrl: (
      process.env.MIND_API_URL ||
      config.baseUrl ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
    apiKey: process.env.MIND_API_KEY || config.apiKey,
    mindId: process.env.MIND_ID || config.mindId,
    promptId: process.env.MIND_PROMPT_ID || config.promptId,
    actorId: process.env.MIND_ACTOR_ID || config.actorId || "prod-cli",
    model: process.env.MIND_MODEL || config.model || "haiku",
    provider: process.env.MIND_PROVIDER || config.provider,
    maxTokens: 256,
    stream: false,
    json: false,
    occurredAt: undefined,
  };

  while (args.length) {
    const flag = args.shift();
    if (
      flag === "--stream" ||
      flag === "--json" ||
      additionalBooleanFlags.has(flag)
    ) {
      options[flag.slice(2)] = true;
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith("--"))
      fail(`A value is required for ${flag}.`);
    switch (flag) {
      case "--base-url":
        options.baseUrl = value.replace(/\/$/, "");
        break;
      case "--mind-id":
        options.mindId = value;
        break;
      case "--prompt-id":
        options.promptId = value;
        break;
      case "--actor":
        options.actorId = value;
        break;
      case "--model":
        options.model = value;
        break;
      case "--provider":
        validateProvider(value);
        options.provider = value;
        break;
      case "--occurred-at":
        options.occurredAt = value;
        break;
      case "--max-tokens":
        options.maxTokens = Number(value);
        if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)
          fail("--max-tokens must be a positive integer.");
        break;
      default:
        fail(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function parseLoginFlags(args, config) {
  const options = {
    apiKey: process.env.MIND_API_KEY,
    baseUrl: (
      process.env.MIND_API_URL ||
      config.baseUrl ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
  };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith("--"))
      fail(`A value is required for ${flag}.`);
    if (flag === "--api-key") options.apiKey = value;
    else if (flag === "--base-url") options.baseUrl = value.replace(/\/$/, "");
    else fail(`Unknown login option: ${flag}`);
  }
  return options;
}

function parseMindFlags(args, config, capabilities = {}) {
  const options = {
    apiKey: process.env.MIND_API_KEY || config.apiKey,
    baseUrl: (
      process.env.MIND_API_URL ||
      config.baseUrl ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
    json: false,
    recallScope: undefined,
  };
  while (args.length) {
    const flag = args.shift();
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith("--"))
      fail(`A value is required for ${flag}.`);
    if (flag === "--base-url") options.baseUrl = value.replace(/\/$/, "");
    else if (flag === "--recall-scope" && capabilities.recallScope) {
      if (value !== "actor" && value !== "mind")
        fail("--recall-scope must be actor or mind.");
      options.recallScope = value;
    } else fail(`Unknown mind option: ${flag}`);
  }
  if (!options.apiKey) fail("Log in first with `pluralmatter login`.");
  return options;
}

function parseChatFlags(args, config) {
  const options = parseRequestFlags(args, config, new Set(["--verbose"]));
  options.verbose = options.verbose === true;
  if (options.stream || options.json || options.occurredAt)
    fail("Chat does not support --stream, --json, or --occurred-at.");
  return options;
}

function parseStatusFlags(args, config) {
  const options = {
    baseUrl: (
      process.env.MIND_API_URL ||
      config.baseUrl ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
    apiKey: process.env.MIND_API_KEY || config.apiKey,
    wait: false,
    timeoutMs: 60_000,
  };

  while (args.length) {
    const flag = args.shift();
    if (flag === "--wait") {
      options.wait = true;
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith("--"))
      fail(`A value is required for ${flag}.`);
    switch (flag) {
      case "--base-url":
        options.baseUrl = value.replace(/\/$/, "");
        break;
      case "--timeout": {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0)
          fail("--timeout must be a positive number of seconds.");
        options.timeoutMs = Math.ceil(seconds * 1_000);
        break;
      }
      default:
        fail(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function configPath() {
  if (process.env.PLURALMATTER_CONFIG) return process.env.PLURALMATTER_CONFIG;
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "pluralmatter", "config.json");
}

async function readConfig() {
  try {
    const value = JSON.parse(await readFile(configPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Could not read ${configPath()}: ${error.message}`);
  }
}

async function writeConfig(config) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function printJsonOrText(response) {
  const text = await response.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

async function authenticatedJson(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message =
      typeof body?.error?.message === "string"
        ? body.error.message
        : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  if (body === undefined)
    throw new Error("The API returned an invalid response.");
  return body;
}

function apiHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function printDiagnostics(response) {
  console.error(`${response.status} ${response.statusText}`);
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = response.headers.get(name);
    if (value) console.error(`${name}: ${value}`);
  }
}

function redact(value) {
  if (typeof value !== "string") return "(invalid)";
  return value.length > 8
    ? `${value.slice(0, 4)}…${value.slice(-4)}`
    : "********";
}

function validateProvider(value) {
  if (!["anthropic", "gemini", "openai"].includes(value))
    fail("Provider must be anthropic, gemini, or openai.");
}

function fail(message) {
  console.error(`Error: ${message}\n`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`Talk to an evolving Plural Matter mind.

Usage:
  pluralmatter login [--api-key KEY]
  pluralmatter logout
  pluralmatter mind create [name] [--recall-scope actor|mind]
  pluralmatter mind list [--json]
  pluralmatter mind use <mind-id>
  pluralmatter mind inspect [mind-id] [--json]
  pluralmatter chat [options]
  pluralmatter send [message] [options]
  pluralmatter status <request-id> [options]
  pluralmatter contemplate [options]
  pluralmatter health

Configuration:
  pluralmatter config set apikey <key>
  pluralmatter config set mind-id <id>
  pluralmatter config set prompt-id <id>
  pluralmatter config set provider <provider>
  pluralmatter config set model <model>
  pluralmatter config list

Login options:
  --api-key KEY        Supply a project API key instead of the hidden prompt
  --base-url URL       Target another API deployment

Mind options:
  --recall-scope SCOPE actor (default) or mind; create only
  --json               Print machine-readable output
  --base-url URL       Target another API deployment

Send and chat options:
  --actor ID           Override the configured actor ID
  --mind-id ID         Override the configured mind ID
  --prompt-id ID       Select a non-default prompt
  --model MODEL        Alias or provider model ID (default: haiku)
  --provider PROVIDER  anthropic, gemini, or openai
  --max-tokens NUMBER  Maximum response tokens (default: 256)
  --base-url URL       Target another API deployment

Send-only options:
  --occurred-at TIME   ISO-8601 event time (defaults to server receipt time)
  --stream             Print raw server-sent events
  --json               Print the full JSON response

Chat-only options and commands:
  --verbose            Show HTTP status, request ID, and mind update status
  /edit                Compose a multiline message; finish with a line containing .
  /clear               Clear local conversation context without resetting the mind
  /info                Show the current mind, provider, model, and update count
  /exit                Leave chat

Status options:
  --wait               Poll until the mind update is no longer processing
  --timeout SECONDS    Stop waiting after this many seconds (default: 60)
  --base-url URL       Target another API deployment

Contemplate uses --actor, --mind-id, and --base-url, then waits up to 60 seconds
for one bounded contemplation pass.

All providers accept the haiku, sonnet, and opus aliases. The configured model
IDs are also accepted. Environment variables MIND_API_KEY, MIND_ID,
MIND_ACTOR_ID, MIND_PROMPT_ID, MIND_PROVIDER, MIND_MODEL, and MIND_API_URL override
saved configuration.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
