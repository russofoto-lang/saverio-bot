export type CheckinOutcome = "fatto" | "non_fatto" | "rimandato";

export type RescheduleInstruction =
  | { kind: "reschedule"; index: number; when: string }
  | { kind: "drop"; index: number }
  | { kind: "none" };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function outcome(value: string): CheckinOutcome | null {
  if (/^(fatto|fatta|fatti|fatte|svolto|svolta)$/.test(value)) return "fatto";
  if (/^(non fatto|non fatta|saltato|saltata)$/.test(value)) return "non_fatto";
  if (/^(rimandato|rimandata)$/.test(value)) return "rimandato";
  return null;
}

export function parseCheckinOutcomes(text: string, eventCount: number): Array<{ index: number; outcome: CheckinOutcome }> {
  const matches = [...normalize(text).matchAll(/\b(\d+)\s*[-:]?\s*(fatto|fatta|fatti|fatte|svolto|svolta|non fatto|non fatta|saltato|saltata|rimandato|rimandata)\b/g)];
  const seen = new Set<number>();
  return matches
    .map((match) => ({ index: Number(match[1]) - 1, outcome: outcome(match[2]) }))
    .filter((item): item is { index: number; outcome: CheckinOutcome } => item.index >= 0 && item.index < eventCount && item.outcome !== null)
    .filter((item) => {
      if (seen.has(item.index)) return false;
      seen.add(item.index);
      return true;
    });
}

export function isCheckinYes(text: string): boolean {
  return /^(?:si|sì|si fai il punto|sì fai il punto|certo|vai|va bene)$/.test(normalize(text));
}

export function isCheckinNo(text: string): boolean {
  return /^(?:no|non ora|salta|non adesso|dopo)$/.test(normalize(text));
}

export function parseRescheduleInstruction(text: string, eventCount: number): RescheduleInstruction {
  const value = normalize(text);
  const drop = value.match(/^(\d+)\s+(?:non serve|annulla|lascia perdere|chiudi)$/);
  if (drop) {
    const index = Number(drop[1]) - 1;
    return index >= 0 && index < eventCount ? { kind: "drop", index } : { kind: "none" };
  }
  const reschedule = text.trim().match(/^(\d+)\s+(?:riprogramma(?:lo)?\s+)?(.+)$/i);
  if (!reschedule) return { kind: "none" };
  const index = Number(reschedule[1]) - 1;
  const when = reschedule[2].trim();
  if (index < 0 || index >= eventCount || !when || /^(?:non serve|annulla|lascia perdere|chiudi)$/i.test(when)) return { kind: "none" };
  return { kind: "reschedule", index, when };
}
