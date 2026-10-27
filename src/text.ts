// Text an agent supplies (the `why` of a review request, a name) is stored as untrusted text: control and bidi
// characters are removed, so it cannot reorder or hide what the owner reads. Pure.

/**
 * Code point ranges that are removed: C0 controls, DEL and C1 controls, soft hyphen, Arabic letter mark, Mongolian
 * vowel separator, zero-width and bidi marks (200B to 200F), line and paragraph separators and bidi embeddings
 * (2028 to 202E), word joiner, invisible operators and bidi isolates (2060 to 206F), BOM, interlinear annotation,
 * supplementary variation selectors (E0100 to E01EF) and Unicode tag characters (E0000 to E007F).
 */
const RANGES: readonly [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  // Unicode tag characters and supplementary variation selectors (invisible; QA fleet 0.3.0 S3). FE00-FE0F stay:
  // VS16 is the emoji presentation selector of ordinary emoji.
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const hex = (n: number) => n.toString(16).padStart(4, "0");
const STRIP = new RegExp(`[${RANGES.map(([a, b]) => `\\u{${hex(a)}}-\\u{${hex(b)}}`).join("")}]`, "gu");

/** Removes the characters above (a tab or newline becomes a space), collapses runs of spaces and trims. */
export function cleanText(s: string): string {
  return s
    .replace(/[\t\n\r]/g, " ")
    .replace(STRIP, "")
    .replace(/ {2,}/g, " ")
    .trim();
}
