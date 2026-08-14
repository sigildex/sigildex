---
name: log-summarizer
description: Summarize a plain-text application log into a short incident report — error counts, the first and last timestamp seen, and the most frequent messages. Use when someone points at a log file and asks what went wrong.
version: 1.0.0
---

# Log summarizer

Turn a raw application log into a short, skimmable incident report.

## When to use this skill

Use it when the user supplies a plain-text log file (or a path to one) and asks
what happened, what failed, or how noisy a service was over a window.

Do not use it for structured telemetry stores or for logs the user has not
shared — this skill reads only the file it is given.

## Steps

1. Read the log file the user named. If the user named a directory, ask which
   file to read rather than guessing.
2. Identify the timestamp format from the first line that carries one. See
   [reference/log-formats.md](reference/log-formats.md) for the formats this
   skill recognizes.
3. Count lines by severity (`ERROR`, `WARN`, `INFO`). Report the counts.
4. Group the `ERROR` lines by their message text with the timestamps and other
   varying fields removed, and list the three largest groups.
5. Report the first and last timestamp observed, so the reader knows the window
   the numbers cover.

## Output

Reply with four short sections, in this order: **Window**, **Counts**,
**Top errors**, **Notes**. Keep the whole report under 200 words. Quote at most
one representative log line per error group, and never more than 200 characters
of it.

## Limits

- Do not modify, move, or delete the log file.
- Do not send the log or any excerpt of it to a network service.
- If the file is larger than a few megabytes, say so and summarize the last
  2,000 lines instead of the whole file.
