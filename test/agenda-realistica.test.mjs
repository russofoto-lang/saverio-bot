import test from "node:test";
import assert from "node:assert/strict";

import { analyzeAgenda } from "../src/agenda-realistica.mts";

test("segnala sovrapposizioni, margini stretti e finestra libera", () => {
  const result = analyzeAgenda([
    { title: "A", start: "2026-09-11T08:00:00+02:00", end: "2026-09-11T09:00:00+02:00" },
    { title: "B", start: "2026-09-11T08:45:00+02:00", end: "2026-09-11T10:00:00+02:00" },
    { title: "C", start: "2026-09-11T10:10:00+02:00", end: "2026-09-11T11:00:00+02:00" },
    { title: "Tutto il giorno", start: "2026-09-11", end: "2026-09-12", allDay: true },
  ], "2026-09-11T08:00:00+02:00", "2026-09-11T20:00:00+02:00");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.tightTransitions.length, 1);
  assert.equal(result.busyMinutes, 170);
  assert.equal(result.allDayCount, 1);
  assert.deepEqual(result.longestFreeWindow, {
    start: "2026-09-11T09:00:00.000Z",
    end: "2026-09-11T18:00:00.000Z",
    minutes: 540,
  });
});
