import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function readSecret(
  label = "API key: ",
  input = process.stdin,
  output = process.stdout,
) {
  if (!input.isTTY) return (await readStream(input)).trim();

  let muted = false;
  const hiddenOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const terminal = createInterface({ input, output: hiddenOutput });
  try {
    const answer = terminal.question(label);
    muted = true;
    const secret = (await answer).trim();
    output.write("\n");
    return secret;
  } finally {
    terminal.close();
  }
}

async function readStream(input) {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
