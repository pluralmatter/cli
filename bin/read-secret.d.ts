import type { Readable, Writable } from "node:stream";

export function readSecret(
  label?: string,
  input?: Readable & { isTTY?: boolean },
  output?: Writable,
): Promise<string>;
