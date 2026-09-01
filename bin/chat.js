import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";

const CHAT_CONTEXT_LIMIT = 28_000;
const PENDING_UPDATE_STATUSES = new Set(["pending", "queued", "retryable"]);

export async function runChat(options, actorToken) {
  const input = process.stdin;
  const output = process.stdout;
  const isTerminal = Boolean(input.isTTY && output.isTTY);
  const style = terminalStyle(isTerminal && process.env.NO_COLOR === undefined);
  const contentWidth = Math.max(20, Math.min((output.columns || 100) - 4, 96));
  const terminal = createInterface({ input, output, terminal: isTerminal });
  const transcript = [];
  const updateWatchers = new Map();
  let editLines;
  let acceptingInput = false;
  let lastEmptyInterruptAt = 0;

  const writeLine = (text = "") => {
    if (acceptingInput && isTerminal) output.write("\r\u001b[2K");
    output.write(`${text}\n`);
    if (acceptingInput && isTerminal) terminal.prompt(true);
  };
  const showPrompt = () => {
    if (!isTerminal) return;
    acceptingInput = true;
    terminal.setPrompt(editLines ? style.dim("… ") : `${style.accent("›")} `);
    terminal.prompt();
  };

  terminal.on("SIGINT", () => {
    const now = Date.now();
    if (terminal.line || editLines) {
      acceptingInput = false;
      terminal.write(null, { ctrl: true, name: "u" });
      editLines = undefined;
      lastEmptyInterruptAt = 0;
      writeLine("Message cancelled.");
      showPrompt();
      return;
    }
    if (now - lastEmptyInterruptAt <= 2_000) {
      acceptingInput = false;
      output.write("\n");
      terminal.close();
      return;
    }
    acceptingInput = false;
    lastEmptyInterruptAt = now;
    writeLine("Press Ctrl-C again to exit.");
    showPrompt();
  });

  writeLine(
    `${style.bold("Plural Matter")}${style.dim(
      ` · ${options.mindId} · ${options.provider || "default"}/${options.model}`,
    )}`,
  );
  writeLine(style.dim("Type /help for commands."));
  writeLine();

  showPrompt();
  try {
    for await (const rawLine of terminal) {
      acceptingInput = false;
      lastEmptyInterruptAt = 0;

      if (editLines) {
        if (rawLine === ".") {
          const message = editLines.join("\n").trim();
          editLines = undefined;
          if (message)
            await sendTurn({
              message,
              options,
              actorToken,
              transcript,
              updateWatchers,
              writeLine,
              style,
              contentWidth,
            });
          else writeLine("Empty multiline message cancelled.");
        } else {
          editLines.push(rawLine);
        }
        showPrompt();
        continue;
      }

      const message = rawLine.trim();
      if (!message) {
        showPrompt();
        continue;
      }
      if (message.startsWith("/")) {
        const shouldExit = handleCommand({
          command: message,
          options,
          transcript,
          updateWatchers,
          writeLine,
          beginEdit() {
            editLines = [];
          },
        });
        if (shouldExit) break;
        showPrompt();
        continue;
      }

      await sendTurn({
        message,
        options,
        actorToken,
        transcript,
        updateWatchers,
        writeLine,
        style,
        contentWidth,
      });
      showPrompt();
    }
  } finally {
    acceptingInput = false;
    terminal.close();
    for (const controller of updateWatchers.values()) controller.abort();
    updateWatchers.clear();
  }
}

function handleCommand({
  command,
  options,
  transcript,
  updateWatchers,
  writeLine,
  beginEdit,
}) {
  const name = command.toLowerCase();
  if (name === "/exit" || name === "/quit") return true;
  if (name === "/help") {
    writeLine(
      "/edit   Compose a multiline message; finish with a line containing .",
    );
    writeLine("/clear  Clear this session's local conversation context");
    writeLine(
      "/info   Show the current mind, provider, model, and update count",
    );
    writeLine("/exit   Leave chat");
    return false;
  }
  if (name === "/edit") {
    beginEdit();
    writeLine(
      "Enter a multiline message. Finish with a line containing only .",
    );
    return false;
  }
  if (name === "/clear") {
    transcript.length = 0;
    writeLine("Local conversation context cleared. The mind was not reset.");
    return false;
  }
  if (name === "/info") {
    writeLine(`Mind: ${options.mindId}`);
    writeLine(`Provider: ${options.provider || "default"}`);
    writeLine(`Model: ${options.model}`);
    writeLine(`Pending session updates: ${updateWatchers.size}`);
    return false;
  }
  writeLine(`Unknown command: ${command}. Type /help for commands.`);
  return false;
}

async function sendTurn({
  message,
  options,
  actorToken,
  transcript,
  updateWatchers,
  writeLine,
  style,
  contentWidth,
}) {
  const applicationContext = chatContext(transcript);
  transcript.push({ role: "user", content: message });

  let response;
  try {
    response = await fetch(`${options.baseUrl}/v1/messages`, {
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
        model: options.model,
        ...(options.provider ? { provider: options.provider } : {}),
        max_tokens: options.maxTokens,
        ...(applicationContext
          ? { application_context: applicationContext }
          : {}),
        messages: [{ role: "user", content: message }],
      }),
    });
  } catch (error) {
    writeLine();
    writeLine(
      style.error(`! ${error instanceof Error ? error.message : error}`),
    );
    writeLine();
    return;
  }

  const requestId = response.headers.get("x-mind-request-id");
  const updateStatus = response.headers.get("x-mind-update-status");
  const pendingCount = response.headers.get("x-mind-update-pending-count");
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    writeLine();
    writeLine(style.error(`! ${publicError(body, response.status)}`));
    if (options.verbose)
      writeVerbose(writeLine, response, requestId, updateStatus, style);
    writeLine();
    return;
  }

  const text = responseText(body);
  if (text) {
    transcript.push({ role: "assistant", content: text });
    writeAssistant(writeLine, text, contentWidth, style);
  } else {
    writeAssistant(writeLine, JSON.stringify(body), contentWidth, style);
  }
  writeUpdateStatus(writeLine, updateStatus, pendingCount, style);
  if (options.verbose)
    writeVerbose(writeLine, response, requestId, updateStatus, style);
  writeLine();

  if (requestId && PENDING_UPDATE_STATUSES.has(updateStatus)) {
    const controller = new AbortController();
    updateWatchers.set(requestId, controller);
    void watchUpdate({
      requestId,
      options,
      controller,
      updateWatchers,
      writeLine,
      style,
    });
  }
}

async function watchUpdate({
  requestId,
  options,
  controller,
  updateWatchers,
  writeLine,
  style,
}) {
  let retryAfterMs = 1_000;
  try {
    while (!controller.signal.aborted) {
      await delay(retryAfterMs, undefined, { signal: controller.signal });
      const response = await fetch(
        `${options.baseUrl}/v1/requests/${encodeURIComponent(requestId)}`,
        {
          headers: { authorization: `Bearer ${options.apiKey}` },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        if (options.verbose)
          writeLine(
            style.dim(`  ! Update status unavailable · request ${requestId}`),
          );
        return;
      }
      const body = await response.json();
      if (body.status === "processing") {
        retryAfterMs = positiveNumber(body.retry_after_ms) ?? 1_000;
        continue;
      }
      updateWatchers.delete(requestId);
      if (body.status === "committed") {
        if (updateWatchers.size === 0)
          writeLine(style.dim("  ✓ Mind caught up through this turn"));
      } else writeLine(style.dim("  – Mind update did not apply"));
      return;
    }
  } catch (error) {
    if (error?.name !== "AbortError" && options.verbose)
      writeLine(
        style.dim(`  ! Update status unavailable · request ${requestId}`),
      );
  } finally {
    updateWatchers.delete(requestId);
  }
}

function chatContext(transcript) {
  if (!transcript.length) return "";
  const heading = "Recent conversation in this CLI chat session:\n";
  const selected = [];
  let length = heading.length;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    const label = entry.role === "user" ? "User" : "Assistant";
    const line = `${label}: ${entry.content}`;
    if (length + line.length + 1 > CHAT_CONTEXT_LIMIT) break;
    selected.unshift(line);
    length += line.length + 1;
  }
  return selected.length ? `${heading}${selected.join("\n")}` : "";
}

function writeAssistant(writeLine, text, width, style) {
  writeLine();
  let firstLine = true;
  for (const sourceLine of text.split("\n")) {
    if (!sourceLine) {
      writeLine();
      continue;
    }
    for (const line of wrapLine(sourceLine, width - 2)) {
      const marker = firstLine ? `${style.assistant("●")} ` : "  ";
      writeLine(`${marker}${line}`);
      firstLine = false;
    }
  }
}

function writeUpdateStatus(writeLine, status, pendingCount, style) {
  if (PENDING_UPDATE_STATUSES.has(status)) {
    const count = positiveInteger(pendingCount);
    writeLine(
      style.dim(`  ◌ Mind update pending${count ? ` · ${count} queued` : ""}`),
    );
  } else if (status === "committed") {
    writeLine(style.dim("  ✓ Mind up to date"));
  } else if (status === "skipped") {
    writeLine(style.dim("  – Mind unchanged"));
  }
}

function writeVerbose(writeLine, response, requestId, updateStatus, style) {
  const details = [`HTTP ${response.status}`];
  if (requestId) details.push(`request ${requestId}`);
  if (updateStatus) details.push(`update ${updateStatus}`);
  writeLine(style.dim(`  ${details.join(" · ")}`));
}

function wrapLine(text, width) {
  if (/^\s|^```/.test(text)) return [text];
  const words = text.trimEnd().split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (line.length + word.length + 1 <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function terminalStyle(enabled) {
  const paint = (code) => (text) =>
    enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  return {
    accent: paint("1;36"),
    assistant: paint("1;37"),
    bold: paint("1"),
    dim: paint("2"),
    error: paint("1;31"),
  };
}

function responseText(body) {
  return Array.isArray(body?.content)
    ? body.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";
}

function publicError(body, status) {
  return typeof body?.error?.message === "string"
    ? body.error.message
    : `Request failed with HTTP ${status}.`;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
