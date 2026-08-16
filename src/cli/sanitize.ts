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
 *
 * Enumerating those by hand cannot be complete: the tag block (U+E0000 to
 * U+E007F) re-encodes the whole of ASCII as characters no terminal shows,
 * which hides an entire second string inside a name that looks ordinary. So
 * the explicit list is backed by a general-category rule covering every
 * format, private-use, and unassigned code point. Private-use and unassigned
 * code points have no defined appearance at all, so what a reader sees is a
 * property of their font rather than of the value being approved. Assigned,
 * visible text — accented Latin, CJK, emoji — is never touched.
 */

/** C0, DEL, and the single-byte C1 controls. */
function isTerminalControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** Format, private-use, and unassigned code points — nothing with a defined glyph. */
const UNTRUSTWORTHY_CATEGORIES = /[\p{Cf}\p{Co}\p{Cn}]/u;

/**
 * Zero-width marks, bidi controls and isolates, separators, and the BOM, plus
 * every format, private-use, and unassigned code point. The named ranges stay
 * explicit because two of them — the line and paragraph separators — are
 * separators rather than format characters, so no category rule reaches them.
 */
function isInvisibleFormat(character: string, codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff ||
    UNTRUSTWORTHY_CATEGORIES.test(character)
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
    else if (isInvisibleFormat(character, codePoint)) escaped += `\\u{${hex(codePoint, 4)}}`;
    else escaped += character;
  }
  return escaped;
}

/**
 * Shortens a display string; sanitization runs first so escapes are counted.
 * The bound counts code points, so an astral character straddling the cut is
 * kept or dropped whole — half a surrogate pair is not a character, and what a
 * terminal makes of one is undefined.
 */
export function truncateForDisplay(value: string, maxLength = 160): string {
  // A string no longer than the bound in UTF-16 units cannot exceed it in code
  // points either, so the common case never walks the string.
  if (value.length <= maxLength) return value;
  let kept = "";
  let counted = 0;
  for (const character of value) {
    if (counted === maxLength) return `${kept}…`;
    kept += character;
    counted += 1;
  }
  return kept;
}

/** Sanitizes and bounds an untrusted string for human-readable output. */
export function displayString(value: string, maxLength = 160): string {
  return truncateForDisplay(sanitizeForTerminal(value), maxLength);
}
