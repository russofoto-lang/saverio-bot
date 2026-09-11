import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMeaningRules,
  classifyWithLearnedRules,
  parseLearningCommand,
} from "../src/chat-learning.mts";

test("propone una regola di significato esplicita", () => {
  const result = parseLearningCommand("Quando dico settimana scorsa intendo lunedi-domenica precedenti");
  assert.equal(result.kind, "propose");
  assert.equal(result.draft.scope, "meaning");
  assert.equal(result.draft.trigger, "settimana scorsa");
  assert.equal(result.draft.replacement, "lunedi-domenica precedenti");
});

test("trasforma una correzione Calendar in una classificazione", () => {
  const result = parseLearningCommand("No, Mounjaro e personale");
  assert.deepEqual(result, {
    kind: "propose",
    draft: {
      scope: "calendar_classification",
      trigger: "Mounjaro",
      effect: "personal",
      instruction: "Negli eventi Calendar, considera \"Mounjaro\" come personale.",
    },
  });
});

test("una frase ordinaria non viene salvata come apprendimento", () => {
  assert.deepEqual(parseLearningCommand("Mounjaro e personale"), { kind: "none" });
});

test("una preferenza esplicita diventa una proposta di comportamento", () => {
  const result = parseLearningCommand("Impara: nelle risposte dammi prima le scadenze");
  assert.equal(result.kind, "propose");
  assert.equal(result.draft.scope, "behavior");
  assert.equal(result.draft.instruction, "Nelle risposte dammi prima le scadenze");
});

test("riconosce elenco e cancellazione delle regole", () => {
  assert.deepEqual(parseLearningCommand("Cosa hai imparato?"), { kind: "list" });
  assert.deepEqual(parseLearningCommand("Dimentica la regola 2"), { kind: "delete", index: 2 });
});

test("applica significati e classificazioni confermate", () => {
  const rules = [
    { id: "1", createdAt: "2026-09-11T00:00:00Z", scope: "meaning", trigger: "il laboratorio", replacement: "Laboratorio Russo Foto", instruction: "interpreta" },
    { id: "2", createdAt: "2026-09-11T00:00:00Z", scope: "calendar_classification", trigger: "Mounjaro", effect: "personal", instruction: "classifica" },
  ];
  assert.equal(
    applyMeaningRules("Appuntamento presso il laboratorio", rules),
    "Appuntamento presso il laboratorio (Laboratorio Russo Foto)",
  );
  assert.equal(classifyWithLearnedRules("Mounjaro dose 2,5", rules), "personal");
});
