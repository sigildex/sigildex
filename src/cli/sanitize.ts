/**
 * Terminal-output sanitization for untrusted strings.
 *
 * Recorded paths produced by the walker are guaranteed free of control
 * characters, but strings that originate from artifact content (frontmatter
 * values) or from a lock file (paths echoed back from an approval record) are
 * untrusted: they can carry escape sequences that rewrite the terminal. Every
 * such string is escaped before it reaches stdout or stderr. JSON output needs
 * no additional treatment beyond JSON encoding.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/gu;

/** Replaces C0 control characters and DEL with visible `\xNN` escapes. */
export function sanitizeForTerminal(value: string): string {
  return value.replace(
    CONTROL_CHARACTERS,
    (character) => `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0").toUpperCase()}`,
  );
}

/** Shortens a display string; sanitization runs first so escapes are counted. */
export function truncateForDisplay(value: string, maxLength = 160): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

/** Sanitizes and bounds an untrusted string for human-readable output. */
export function displayString(value: string, maxLength = 160): string {
  return truncateForDisplay(sanitizeForTerminal(value), maxLength);
}
