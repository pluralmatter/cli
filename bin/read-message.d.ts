import type { Readable, Writable } from "node:stream";

export function readMessage(
  input?: Readable & { isTTY?: boolean },
  output?: Writable,
  label?: string,
): Promise<string>;
