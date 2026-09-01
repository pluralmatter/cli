import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repositoryRoot, "bin", "pluralmatter.js");

test("prints its package version and help", async () => {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const version = await runCli(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pluralmatter login/);
  assert.match(help.stdout, /pluralmatter chat/);
});

test("logs in securely and sends a piped message", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && request.url === "/v1/minds") {
      response.end(
        JSON.stringify([
          { id: "mind_test", name: "Test mind", status: "active" },
        ]),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/actor-tokens") {
      response.end(JSON.stringify({ actor_token: "actor_test" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/messages") {
      response.setHeader("x-mind-request-id", "request_test");
      response.setHeader("x-mind-update-status", "committed");
      response.end(
        JSON.stringify({ content: [{ type: "text", text: "Hello back" }] }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "Not found" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), "pluralmatter-cli-test-"));
  const configPath = join(directory, "config.json");
  const environment = { PLURALMATTER_CONFIG: configPath };

  try {
    const login = await runCli(
      ["login", "--api-key", "pm_test", "--base-url", baseUrl],
      { environment },
    );
    assert.equal(login.status, 0, login.stderr);
    assert.match(login.stdout, /Logged in/);
    assert.doesNotMatch(login.stdout, /pm_test/);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.apiKey, "pm_test");
    assert.equal(config.mindId, "mind_test");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);

    const sent = await runCli(["send"], {
      environment,
      input: "Hello from stdin\n",
    });
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(sent.stdout.trim(), "Hello back");

    const message = requests.find(
      (request) => request.method === "POST" && request.url === "/v1/messages",
    );
    assert(message);
    const payload = JSON.parse(message.body);
    assert.equal(payload.mind_id, "mind_test");
    assert.deepEqual(payload.messages, [
      { role: "user", content: "Hello from stdin" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...options.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input);
  });
}
