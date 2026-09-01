import { createInterface } from "node:readline/promises";

export async function readMessage(
  input = process.stdin,
  output = process.stdout,
  label = "Message: ",
) {
  if (!input.isTTY) return (await readStream(input)).trim();

  const terminal = createInterface({ input, output });
  try {
    return (await terminal.question(label)).trim();
  } finally {
    terminal.close();
  }
}

async function readStream(input) {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
