export type CalendarReadRange = {
  start: string;
  end: string;
  label: string;
};

export type CalendarReadRequest =
  | { kind: "read"; hasRequestedRange: boolean; asksForWork: boolean }
  | { kind: "capability" }
  | { kind: "none" };

export type CalendarReadPlan =
  | {
    kind: "read";
    action: "read";
    source: "calendar";
    ranges: CalendarReadRange[];
    periodSource: "message" | "context";
    filter: "work" | "all";
  }
  | { kind: "capability"; action: "read"; source: "calendar" }
  | { kind: "needs_period"; action: "read"; source: "calendar" }
  | { kind: "invalid_period"; action: "read"; source: "calendar" }
  | { kind: "none" };

export type CalendarWorkClassification = "work" | "personal" | "unknown";

const MONTHS: Record<string, number> = {
  gennaio: 0,
  febbraio: 1,
  marzo: 2,
  aprile: 3,
  maggio: 4,
  giugno: 5,
  luglio: 6,
  agosto: 7,
  settembre: 8,
  ottobre: 9,
  novembre: 10,
  dicembre: 11,
};

const WEEKDAYS: Record<string, { day: number; nextLabel: string }> = {
  lunedi: { day: 1, nextLabel: "lunedi prossimo" },
  martedi: { day: 2, nextLabel: "martedi prossimo" },
  mercoledi: { day: 3, nextLabel: "mercoledi prossimo" },
  giovedi: { day: 4, nextLabel: "giovedi prossimo" },
  venerdi: { day: 5, nextLabel: "venerdi prossimo" },
  sabato: { day: 6, nextLabel: "sabato prossimo" },
  domenica: { day: 7, nextLabel: "domenica prossima" },
};

export function normalizeCalendarText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasCalendarRangeReference(text: string): boolean {
  const value = normalizeCalendarText(text);
  return /\b(?:oggi|ieri|domani|dopodomani|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|settimana)\b/.test(value)
    || /\b(?:[1-9]|[12]\d|3[01])\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+\d{4})?\b/.test(value)
    || /\b(?:[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])(?:\/\d{2,4})?\b/.test(value)
    || /\bultimi\s+7\s+giorni\b/.test(value);
}

function hasCalendarCapabilityQuestion(value: string): boolean {
  const mentionsCalendar = /\b(?:calendar|calendario|agenda)\b/.test(value);
  const asksCapability = /\b(?:riesci|puoi|sai|accesso)\b/.test(value)
    && /\b(?:leggere|consultare|vedere|accedere|controllare)\b/.test(value);
  return mentionsCalendar && asksCapability;
}

export function parseCalendarReadRequest(text: string): CalendarReadRequest {
  const value = normalizeCalendarText(text);
  if (hasCalendarCapabilityQuestion(value) && !hasCalendarRangeReference(value)) return { kind: "capability" };

  const hasWriteVerb = /\b(?:crea|creare|aggiungi|aggiungere|fissa|fissare|inserisci|inserire|metti|mettere|segna|segnare|modifica|sposta|rinomina|cambia|aggiorna|cancella|elimina|rimuovi)\b/.test(value);
  if (hasWriteVerb) return { kind: "none" };

  const hasCalendarWord = /\b(?:calendar|calendario|agenda)\b/.test(value);
  const hasCommitmentWord = /\b(?:impegno|impegni|appuntamento|appuntamenti)\b/.test(value);
  const hasDateReference = hasCalendarRangeReference(value);
  const hasReadVerb = /\b(?:cerca|cercare|cerchi|controlla|controllare|leggi|leggere|consulta|consultare|guarda|guardare|mostra|mostrare|verifica|verificare|trova|trovare)\b/.test(value);
  const asksForWork = /\b(?:lavoro|lavori|lavorativ[oaie]|da fare|dovevo fare)\b/.test(value);

  if (hasCalendarWord && (hasCommitmentWord || hasDateReference || hasReadVerb)) return { kind: "read", hasRequestedRange: hasDateReference, asksForWork };
  if (hasCommitmentWord && hasDateReference) return { kind: "read", hasRequestedRange: true, asksForWork };

  const isShortCalendarRequest = value === "calendar"
    || value === "calendario"
    || value === "agenda"
    || value.startsWith("calendario ")
    || value.startsWith("calendario:")
    || value.startsWith("agenda ")
    || value.startsWith("agenda:")
    || value.includes("che appuntamenti ho")
    || value.includes("che appuntamento ho")
    || value.includes("che impegni ho")
    || value.includes("che impegno ho")
    || value.includes("miei impegni")
    || value.includes("cosa ho oggi")
    || value.includes("cosa ho domani");
  return isShortCalendarRequest
    ? { kind: "read", hasRequestedRange: hasDateReference, asksForWork }
    : { kind: "none" };
}

export function isCalendarCapabilityQuestion(text: string): boolean {
  return parseCalendarReadRequest(text).kind === "capability";
}

export function isCalendarReadIntent(text: string): boolean {
  return parseCalendarReadRequest(text).kind === "read";
}

export function isCalendarReadContinuation(text: string): boolean {
  const value = normalizeCalendarText(text);
  return /^(?:e\s+)?(?:di\s+|per\s+)?(?:oggi|ieri|domani|dopodomani|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)(?:\s+(?:prossim[oa]|scors[oa]))?$/.test(value)
    || /^(?:e\s+)?(?:il\s+)?(?:[1-9]|[12]\d|3[01])\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+\d{4})?$/.test(value)
    || /^(?:e\s+)?(?:la\s+)?(?:scorsa|questa|prossima)\s+settimana$/.test(value);
}

export function hasInvalidCalendarDate(text: string): boolean {
  const value = normalizeCalendarText(text);
  const namedDate = value.match(/\b([1-9]|[12]\d|3[01])\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/);
  const numericDate = value.match(/\b([1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])(?:\/(\d{2,4}))?\b/);
  if (!namedDate && !numericDate) return false;
  const day = Number((namedDate ?? numericDate)?.[1]);
  const month = namedDate ? MONTHS[namedDate[2]] : Number(numericDate?.[2]) - 1;
  const rawYear = (namedDate ?? numericDate)?.[3];
  // Per validare giorno/mese senza anno usiamo un anno bisestile: 29 febbraio
  // resta possibile, mentre 30 febbraio e 31 aprile no.
  const year = rawYear ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear) : 2024;
  return validUtcDate(year, month, day) === null;
}

export function planCalendarRead(
  text: string,
  timezone: string,
  contextRanges: CalendarReadRange[] | null,
  now = new Date(),
): CalendarReadPlan {
  const request = parseCalendarReadRequest(text);
  if (request.kind === "capability") return { kind: "capability", action: "read", source: "calendar" };

  const continuation = request.kind === "none" && isCalendarReadContinuation(text) && Boolean(contextRanges?.length);
  if (request.kind === "none" && !continuation) return { kind: "none" };

  const hasRequestedRange = request.kind === "read"
    ? request.hasRequestedRange
    : hasCalendarRangeReference(text);
  if (hasRequestedRange && hasInvalidCalendarDate(text)) {
    return { kind: "invalid_period", action: "read", source: "calendar" };
  }

  if (hasRequestedRange) {
    return {
      kind: "read",
      action: "read",
      source: "calendar",
      ranges: getCalendarReadRanges(text, timezone, now),
      periodSource: "message",
      filter: request.kind === "read" && request.asksForWork ? "work" : "all",
    };
  }

  if (contextRanges?.length) {
    return {
      kind: "read",
      action: "read",
      source: "calendar",
      ranges: contextRanges,
      periodSource: "context",
      filter: request.kind === "read" && request.asksForWork ? "work" : "all",
    };
  }
  return { kind: "needs_period", action: "read", source: "calendar" };
}

export function classifyCalendarEventTitle(title: string): CalendarWorkClassification {
  const value = normalizeCalendarText(title);
  if (!value) return "unknown";
  if (/\b(?:mounjaro|medico|dentista|visita|farmaco|terapia|palestra|allenamento|spesa|supermercato|pranzo|cena|compleanno|famiglia|scuola|vacanza)\b/.test(value)) {
    return "personal";
  }
  if (/\b(?:cliente|preventivo|album|foto|fotograf|stampa|stampare|copertina|matrimonio|comunione|battesimo|cerimonia|studio|follow up|laboratorio|scarico schede|consegna|sopralluogo|contratto|pagamento|fattura|call|riunione|meeting|video|montaggio|social|campagna|evento|comune|pro loco)\b/.test(value)) {
    return "work";
  }
  return "unknown";
}

function hasPastMeaning(value: string): boolean {
  return /\b(?:avevo|avevamo|dovevo|dovevamo|era|erano|passat[oa]|precedente|scors[oa]|ieri)\b/.test(value)
    || /\b(?:ho|abbiamo)\s+avut[oa]\b/.test(value)
    || /\bc\s+er(?:a|ano)\b/.test(value);
}

function hasFutureMeaning(value: string): boolean {
  return /\b(?:avro|avremo|dovro|dovremo|futur[oa]|prossim[oa])\b/.test(value);
}

export function getRomeDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function getRomeCurrentDateDescription(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
}

function toRomeBoundaryIso(date: Date, timezone: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const probe = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate(), 12));
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offset = offsetPart.replace("GMT", "") || "+00:00";
  return `${year}-${month}-${day}T00:00:00${offset}`;
}

function validUtcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

function resolveYearWithoutExplicitYear(
  month: number,
  day: number,
  today: { year: number; month: number; day: number },
  value: string,
): number {
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const thisYear = Date.UTC(today.year, month, day);
  if (hasPastMeaning(value) && thisYear > todayUtc) return today.year - 1;
  if (hasFutureMeaning(value) && thisYear < todayUtc) return today.year + 1;
  return today.year;
}

export function getCalendarReadRange(
  text: string,
  timezone: string,
  now = new Date(),
): CalendarReadRange {
  const value = normalizeCalendarText(text);
  const today = getRomeDateParts(now, timezone);
  const todayStart = new Date(Date.UTC(today.year, today.month - 1, today.day));
  let start = new Date(todayStart);
  let days = 1;
  let label = "oggi";

  const namedDate = value.match(/\b([1-9]|[12]\d|3[01])\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/);
  const numericDate = value.match(/\b([1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])(?:\/(\d{2,4}))?\b/);
  const weekdayMatch = value.match(/\b(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)(?:\s+prossim[oa])?\b/);

  if (namedDate || numericDate) {
    const day = Number((namedDate ?? numericDate)?.[1]);
    const monthName = namedDate?.[2];
    const month = monthName ? MONTHS[monthName] : Number(numericDate?.[2]) - 1;
    const rawYear = (namedDate ?? numericDate)?.[3];
    const explicitYear = rawYear ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear) : null;
    const year = explicitYear ?? resolveYearWithoutExplicitYear(month, day, today, value);
    const candidate = validUtcDate(year, month, day);
    if (candidate) {
      start = candidate;
      label = monthName ? `il ${day} ${monthName} ${year}` : `il ${day}/${month + 1}/${year}`;
    }
  } else if (value.includes("dopodomani")) {
    start.setUTCDate(start.getUTCDate() + 2);
    label = "dopodomani";
  } else if (value.includes("domani")) {
    start.setUTCDate(start.getUTCDate() + 1);
    label = "domani";
  } else if (value.includes("ieri")) {
    start.setUTCDate(start.getUTCDate() - 1);
    label = "ieri";
  } else if (weekdayMatch) {
    const target = WEEKDAYS[weekdayMatch[1]];
    const currentDay = start.getUTCDay() || 7;
    let delta = target.day - currentDay;
    if (hasPastMeaning(value) && !hasFutureMeaning(value)) {
      if (delta >= 0) delta -= 7;
    } else if (delta <= 0) {
      delta += 7;
    }
    start.setUTCDate(start.getUTCDate() + delta);
    label = delta < 0
      ? `${weekdayMatch[1]} scorso`
      : (weekdayMatch[0].includes("prossim") ? target.nextLabel : weekdayMatch[1]);
  } else if (value.includes("settimana")) {
    const dayOfWeek = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (dayOfWeek - 1));
    if (/\b(?:scorsa|passata|precedente)\s+settimana\b|\bsettimana\s+(?:scorsa|passata|precedente)\b/.test(value)) {
      start.setUTCDate(start.getUTCDate() - 7);
      label = "la scorsa settimana";
    } else if (/\bprossima\s+settimana\b|\bsettimana\s+prossima\b/.test(value)) {
      start.setUTCDate(start.getUTCDate() + 7);
      label = "la prossima settimana";
    } else {
      label = "questa settimana";
    }
    days = 7;
  } else if (/\bultimi\s+7\s+giorni\b/.test(value)) {
    start.setUTCDate(start.getUTCDate() - 6);
    days = 7;
    label = "gli ultimi 7 giorni";
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return {
    start: toRomeBoundaryIso(start, timezone),
    end: toRomeBoundaryIso(end, timezone),
    label,
  };
}

export function getCalendarReadRanges(
  text: string,
  timezone: string,
  now = new Date(),
): CalendarReadRange[] {
  const value = normalizeCalendarText(text);
  const keywords = ["oggi", "ieri", "domani", "dopodomani", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica"];
  const matched = keywords.filter((keyword) => new RegExp(`\\b${keyword}\\b`).test(value));
  if (matched.length < 2) return [getCalendarReadRange(text, timezone, now)];

  const seen = new Set<string>();
  return matched
    .map((keyword) => getCalendarReadRange(keyword, timezone, now))
    .filter((range) => {
      if (seen.has(range.start)) return false;
      seen.add(range.start);
      return true;
    });
}
