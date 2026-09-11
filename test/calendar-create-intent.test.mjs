import test from "node:test";
import assert from "node:assert/strict";

import { isCalendarCreateIntent } from "../src/calendar-create-intent.mts";

test("riconosce segna sul calendario come creazione, non come chat libera", () => {
  assert.equal(isCalendarCreateIntent("Segna sul calendario per domani mattina alle 13,00 trovare a Foggia"), true);
  assert.equal(isCalendarCreateIntent("Metti sul calendario domani alle 9 chiamare Luca"), true);
});
