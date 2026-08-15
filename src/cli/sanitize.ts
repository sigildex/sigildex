/**
 * Terminal-output sanitization for untrusted strings.
 *
 * Recorded paths produced by the walker are guaranteed free of control
 * characters, but strings that originate from artifact content (frontmatter
 * values) or from a lock file (paths echoed back from an approval record) are
 * untrusted: they can carry escape sequences that rewrite the terminal. Every
 * such string is escaped before it reaches stdout or stderr. JSON output needs
 * no additional treatment beyond JSON encoding.
 *
 * Two families are escaped. C0, DEL, and the single-byte C1 controls
 * (U+0080 to U+009F) are the sequence introducers: a terminal in UTF-8 mode
 * may act on U+009B exactly as it acts on ESC followed by "[", so escaping C0
 * alone would leave the same injection reachable one code point higher.
 * Invisible formatting characters — bidirectional overrides and isolates,
 * zero-width marks, the byte-order mark, and the line/paragraph separators —
 * carry no glyph but reorder or hide the text around them, which lets an
 * untrusted frontmatter value misrepresent what a reviewer is approving.
 */

/** C0, DEL, and the single-byte C1 controls. */
function isTerminalControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** Zero-width marks, bidi controls and isolates, separators, and the BOM. */
function isInvisibleFormat(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

function hex(codePoint: number, width: number): string {
  return codePoint.toString(16).toUpperCase().padStart(width, "0");
}

/**
 * Replaces control characters with visible `\xNN` escapes and invisible
 * formatting characters with visible `\u{XXXX}` escapes.
 */
export function sanitizeForTerminal(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (isTerminalControl(codePoint)) escaped += `\\x${hex(codePoint, 2)}`;
    else if (isInvisibleFormat(codePoint)) escaped += `\\u{${hex(codePoint, 4)}}`;
    else escaped += character;
  }
  return escaped;
}

/** Shortens a display string; sanitization runs first so escapes are counted. */
export function truncateForDisplay(value: string, maxLength = 160): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

/** Sanitizes and bounds an untrusted string for human-readable output. */
export function displayString(value: string, maxLength = 160): string {
  return truncateForDisplay(sanitizeForTerminal(value), maxLength);
}
