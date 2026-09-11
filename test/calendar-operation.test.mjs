import test from "node:test";
import assert from "node:assert/strict";
import { interpretCalendarOperation } from "../src/calendar-operation.mts";

const TIMEZONE = "Europe/Rome";
const NOW = new Date("2026-09-11T13:00:00+02:00");

test("un solo interprete separa lettura, creazione, stato e promemoria", () => {
  assert.equal(interpretCalendarOperation("Cerca su Calendar gli impegni lavorativi della scorsa settimana", TIMEZONE, null, NOW).kind, "read");
  assert.equal(interpretCalendarOperation("Segna sul calendario per domani alle 13 preparare attrezzatura", TIMEZONE, null, NOW).kind, "create");
  assert.equal(interpretCalendarOperation("Hai segnato l'appuntamento?", TIMEZONE, null, NOW).kind, "status");
  assert.equal(interpretCalendarOperation("Promemoria oggi alle 19 prendere vino", TIMEZONE, null, NOW).kind, "none");
});
