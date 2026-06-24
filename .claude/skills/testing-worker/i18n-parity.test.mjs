import * as H from "./harness.mjs";
import en from "../../../src/i18n/en.json";
import ru from "../../../src/i18n/ru.json";
const { test, describe, assert } = H;

// The engine's locale files must stay key-for-key in sync for DISPLAYED strings: a displayed key present in
// one language but not the other renders in the fallback language (DEFAULT_LANG) or, worse, as the raw key.
// EXEMPT: input-matching vocabularies resolved via tList() (config value words, command sub-aliases, fact-
// refusal markers) are per-language BY DESIGN — tList has no fallback, and the universal/English forms are
// hardcoded in code, so these keys legitimately exist only where a language adds extras.
const INPUT_VOCAB = /_words$|_aliases$|^mem_sub_|^mem_refusal_/;
describe("i18n parity", () => {
  test("engine en.json and ru.json have the same DISPLAYED-string key set", () => {
    const missingInRu = Object.keys(en).filter((k) => !(k in ru) && !INPUT_VOCAB.test(k));
    const missingInEn = Object.keys(ru).filter((k) => !(k in en) && !INPUT_VOCAB.test(k));
    assert.deepEqual(missingInRu, [], "displayed keys in en.json missing from ru.json: " + missingInRu.join(", "));
    assert.deepEqual(missingInEn, [], "displayed keys in ru.json missing from en.json: " + missingInEn.join(", "));
  });
});
