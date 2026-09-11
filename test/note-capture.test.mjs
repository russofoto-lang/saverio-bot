import test from "node:test";
import assert from "node:assert/strict";

import { extractNoteCapture } from "../src/note-capture.mts";

test("estrae il contenuto di una richiesta esplicita di nota", () => {
  assert.equal(extractNoteCapture("Prendi nota: oggi ho pagato il carrozziere"), "oggi ho pagato il carrozziere");
  assert.equal(extractNoteCapture("Segna una nota che ho consegnato l'album"), "ho consegnato l'album");
  assert.equal(extractNoteCapture("Segna cine nota: pagamento assicurazione"), "pagamento assicurazione");
});

test("non intercetta una frase che non chiede di prendere nota", () => {
  assert.equal(extractNoteCapture("Ho segnato un appuntamento sul calendario"), null);
});
