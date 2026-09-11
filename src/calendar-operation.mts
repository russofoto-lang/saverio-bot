import { isCalendarCreateIntent } from "./calendar-create-intent.mts";
import { normalizeCalendarText, planCalendarRead, type CalendarReadPlan, type CalendarReadRange } from "./calendar-routing.mts";

export type CalendarOperation =
  | { kind: "read"; plan: Exclude<CalendarReadPlan, { kind: "none" } | { kind: "capability" }> }
  | { kind: "capability" }
  | { kind: "create" }
  | { kind: "mutate" }
  | { kind: "status" }
  | { kind: "none" };

export function interpretCalendarOperation(text: string, timezone: string, context: CalendarReadRange[] | null): CalendarOperation {
  const value = normalizeCalendarText(text);
  // I promemoria hanno un proprio flusso: Calendar viene proposto dopo che
  // l'avviso Telegram e' stato registrato.
  if (/\b(?:promemoria|ricordami)\b/.test(value)) return { kind: "none" };
  if (/\b(?:hai|avete)\s+(?:segnato|creato|inserito|aggiunto)\b[\s\S]*\b(?:appuntamento|evento|impegno)\b/.test(value)) return { kind: "status" };
  if (/\b(?:modifica|sposta|rinomina|cambia|aggiorna|cancella|elimina|rimuovi)\b/.test(value) && /\b(?:calendario|evento|appuntamento|impegno)\b/.test(value)) return { kind: "mutate" };
  if (isCalendarCreateIntent(text)) return { kind: "create" };
  const plan = planCalendarRead(text, timezone, context);
  if (plan.kind === "capability") return { kind: "capability" };
  if (plan.kind !== "none") return { kind: "read", plan };
  return { kind: "none" };
}
