#!/usr/bin/env node
import { main } from "./main.js";

// A consumer that stops reading (`sigildex check | head -1`) closes our stdout.
// The verdict was already decided; report the broken pipe as a tool error
// (exit 1) without a stack trace. Never 0, never a reserved code.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.stderr.write("Error: stdout closed before the output was written\n");
  process.exit(1);
});

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `Error: Unexpected failure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
