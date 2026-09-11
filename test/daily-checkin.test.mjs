import test from "node:test";
import assert from "node:assert/strict";

import {
  isCheckinNo,
  isCheckinYes,
  parseCheckinOutcomes,
  parseRescheduleInstruction,
} from "../src/daily-checkin.mts";

test("legge esiti numerati del check-in senza duplicare lo stesso impegno", () => {
  assert.deepEqual(parseCheckinOutcomes("1 fatto, 2 non fatto, 3 rimandato, 2 fatto", 3), [
    { index: 0, outcome: "fatto" },
    { index: 1, outcome: "non_fatto" },
    { index: 2, outcome: "rimandato" },
  ]);
});

test("riconosce risposta positiva e rinvio del check-in", () => {
  assert.equal(isCheckinYes("Sì"), true);
  assert.equal(isCheckinYes("vai"), true);
  assert.equal(isCheckinNo("non ora"), true);
});

test("interpreta riprogrammazione e chiusura di un impegno incompleto", () => {
  assert.deepEqual(parseRescheduleInstruction("2 domani alle 10", 3), { kind: "reschedule", index: 1, when: "domani alle 10" });
  assert.deepEqual(parseRescheduleInstruction("2 non serve", 3), { kind: "drop", index: 1 });
  assert.deepEqual(parseRescheduleInstruction("4 domani", 3), { kind: "none" });
});
