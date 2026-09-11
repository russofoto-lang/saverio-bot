export function extractNoteCapture(text: string): string | null {
  const original = text.trim();
  const match = original.match(/^(?:prendi(?:mi)?|tieni|annota|segna(?:mi)?)\b[\s\S]{0,30}\bnota\b\s*[:;,\-–]?\s*([\s\S]+)$/i);
  if (!match) return null;
  const fact = match[1].replace(/^che\s+/i, "").trim();
  return fact ? fact.slice(0, 1_000) : null;
}
