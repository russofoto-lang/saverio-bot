import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCalendarEventTitle,
  getCalendarReadRange,
  getCalendarReadRanges,
  hasInvalidCalendarDate,
  hasCalendarRangeReference,
  isCalendarCapabilityQuestion,
  isCalendarReadIntent,
  parseCalendarReadRequest,
  planCalendarRead,
} from "../src/calendar-routing.mts";

const TIMEZONE = "Europe/Rome";
const NOW = new Date("2026-09-11T10:00:00.000Z");

test("riconosce come letture Calendar le frasi reali della conversazione", () => {
  const messages = [
    "Cerca nel calendario tra gli eventi della scorsa settimana quali lavori dovevo fare",
    "Che impegni avevo martedì 1 settembre?",
    "Controlla sul calendar",
    "Devi cercare che cosa era segnato sul calendario il 1 settembre",
    "Devi cercare di calendar",
    "Cerca su calendar che impegni avevo il 1 settembre 2026",
    "Adesso mi cerchi che impegno lavorativi avevo segnato su calendar?",
    "Cerca su calendar gli impegni lavorativi della scorsa settimana",
  ];

  for (const message of messages) {
    assert.equal(isCalendarReadIntent(message), true, message);
  }
});

test("una domanda sulla capacità Calendar non viene scambiata per creazione evento", () => {
  assert.equal(isCalendarReadIntent("Riesci a leggere il calendario?"), false);
  assert.equal(isCalendarCapabilityQuestion("Riesci a leggere il calendario?"), true);
  assert.deepEqual(parseCalendarReadRequest("Riesci a leggere il calendario?"), { kind: "capability" });
  assert.equal(hasCalendarRangeReference("Riesci a leggere il calendario?"), false);
});

test("una richiesta di creazione non viene scambiata per lettura", () => {
  assert.equal(isCalendarReadIntent("Puoi segnare in calendario domani alle 10 un appuntamento?"), false);
});

test("classifica gli eventi lavorativi senza mescolare gli impegni personali", () => {
  assert.equal(classifyCalendarEventTitle("Mandare in stampa foto di gruppo sorella di Fatima"), "work");
  assert.equal(classifyCalendarEventTitle("Mounjaro dose 2,5 mg"), "personal");
  assert.equal(classifyCalendarEventTitle("Un appuntamento per"), "unknown");
});

test("1 settembre senza anno resta nel 2026 quando la domanda è al passato", () => {
  const range = getCalendarReadRange("Che impegni avevo martedì 1 settembre?", TIMEZONE, NOW);
  assert.equal(range.start, "2026-09-01T00:00:00+02:00");
  assert.equal(range.end, "2026-09-02T00:00:00+02:00");
  assert.equal(range.label, "il 1 settembre 2026");
});

test("una data futura in una domanda al passato usa l'occorrenza precedente", () => {
  const range = getCalendarReadRange("Che impegni avevo il 20 dicembre?", TIMEZONE, NOW);
  assert.equal(range.start, "2025-12-20T00:00:00+01:00");
});

test("un giorno della settimana al passato cerca indietro, non la settimana futura", () => {
  const range = getCalendarReadRange("Che impegni avevo martedì?", TIMEZONE, NOW);
  assert.equal(range.start, "2026-09-08T00:00:00+02:00");
});

test("scorsa settimana indica lunedì-domenica precedenti", () => {
  const range = getCalendarReadRange("eventi della scorsa settimana", TIMEZONE, NOW);
  assert.equal(range.start, "2026-08-31T00:00:00+02:00");
  assert.equal(range.end, "2026-09-07T00:00:00+02:00");
  assert.equal(range.label, "la scorsa settimana");
});

test("questa e prossima settimana restano distinte", () => {
  const current = getCalendarReadRange("questa settimana", TIMEZONE, NOW);
  const next = getCalendarReadRange("la prossima settimana", TIMEZONE, NOW);
  assert.equal(current.start, "2026-09-07T00:00:00+02:00");
  assert.equal(current.end, "2026-09-14T00:00:00+02:00");
  assert.equal(next.start, "2026-09-14T00:00:00+02:00");
  assert.equal(next.end, "2026-09-21T00:00:00+02:00");
});

test("oggi e domani producono due intervalli distinti", () => {
  const ranges = getCalendarReadRanges("cosa ho oggi e domani?", TIMEZONE, NOW);
  assert.deepEqual(ranges.map((range) => range.start), [
    "2026-09-11T00:00:00+02:00",
    "2026-09-12T00:00:00+02:00",
  ]);
});

test("l'intera conversazione usa sempre Calendar, il periodo corretto e il filtro corretto", () => {
  let context = null;
  const plan = (message) => {
    const result = planCalendarRead(message, TIMEZONE, context, NOW);
    if (result.kind === "read") context = result.ranges;
    return result;
  };

  const weeklyWork = plan("Cerca nel calendario tra gli eventi della scorsa settimana quali lavori dovevo fare");
  assert.deepEqual(weeklyWork, {
    kind: "read", action: "read", source: "calendar", filter: "work", periodSource: "message",
    ranges: [{ start: "2026-08-31T00:00:00+02:00", end: "2026-09-07T00:00:00+02:00", label: "la scorsa settimana" }],
  });

  assert.deepEqual(plan("Riesci a leggere il calendario?"), { kind: "capability", action: "read", source: "calendar" });

  const firstSeptember = plan("Che impegni avevo martedi 1 settembre?");
  assert.equal(firstSeptember.kind, "read");
  assert.equal(firstSeptember.periodSource, "message");
  assert.equal(firstSeptember.filter, "all");
  assert.equal(firstSeptember.ranges[0].start, "2026-09-01T00:00:00+02:00");

  const retry = plan("Controlla sul calendar");
  assert.equal(retry.kind, "read");
  assert.equal(retry.periodSource, "context");
  assert.equal(retry.ranges[0].start, "2026-09-01T00:00:00+02:00");

  const directWeeklyWork = plan("Cerca su calendar gli impegni lavorativi della scorsa settimana");
  assert.equal(directWeeklyWork.kind, "read");
  assert.equal(directWeeklyWork.filter, "work");
  assert.equal(directWeeklyWork.ranges[0].start, "2026-08-31T00:00:00+02:00");
});

test("date impossibili non vengono trasformate silenziosamente in oggi", () => {
  assert.equal(hasInvalidCalendarDate("che impegni avevo il 31 febbraio?"), true);
  assert.equal(hasInvalidCalendarDate("che impegni avevo il 29 febbraio?"), false);
  assert.deepEqual(
    planCalendarRead("che impegni avevo il 31 febbraio 2026 sul calendario", TIMEZONE, null, NOW),
    { kind: "invalid_period", action: "read", source: "calendar" },
  );
});
