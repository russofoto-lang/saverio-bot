function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCalendarCreateIntent(text: string): boolean {
  const value = normalize(text);
  return value.startsWith("appuntamento ")
    || value.startsWith("appuntamento:")
    || value.startsWith("un appuntamento ")
    || value.startsWith("un appuntamento:")
    || value.startsWith("calendario ")
    || value.startsWith("calendario:")
    || /\b(?:crea|creare|aggiungi|aggiungere|fissa|fissare|inserisci|inserire)\s+(?:un\s+)?(?:evento|appuntamento|impegno)\b/.test(value)
    || /\b(?:metti|segna|inserisci|aggiungi)\s+(?:sul|nel|in)\s+calendari[oa]\b/.test(value)
    || value.includes("segna un appuntamento")
    || value.includes("segna appuntamento")
    || value.includes("aggiungi appuntamento")
    || value.includes("crea appuntamento")
    || value.includes("crea evento");
}
