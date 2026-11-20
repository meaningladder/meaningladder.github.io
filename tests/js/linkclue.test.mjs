import { test } from "node:test";
import assert from "node:assert/strict";
import { linkClue } from "../../js/logic.js";
import { INFORMATIVE } from "../../js/seeded.js";

const SYM = ["Synonym", "SimilarTo", "LocatedNear"];

test("every informative relation has a plain dash-free clue", () => {
  for (const rel of INFORMATIVE) {
    for (const f of SYM.includes(rel) ? [null] : [true, false]) {
      const t = linkClue(rel, f, "roof");
      assert.ok(t.includes("roof") && !/[\u2013\u2014-]/.test(t), `${rel} ${f}: ${t}`);
    }
  }
});

test("brief examples and RelatedTo", () => {
  assert.equal(linkClue("AtLocation", false, "roof"), "Something you find at roof");
  assert.equal(linkClue("AtLocation", true, "roof"), "Where you find roof");
  assert.equal(linkClue("IsA", true, "dog"), "dog is a kind of this");
  assert.equal(linkClue("Synonym", null, "big"), "Means the same as big");
  assert.throws(() => linkClue("RelatedTo", null, "x"));
});
