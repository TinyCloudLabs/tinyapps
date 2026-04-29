import assert from "node:assert/strict";

import { resolveManifest } from "@tinycloud/sdk-core";

import { analyzeCorrelations, fmtDay, fmtTime, normalizeMealDraft, normalizeStoredRecord } from "../src/analysis.js";
import {
  APP_IDS,
  FOOD_MANIFEST,
  INSIGHT_MANIFEST,
  PAIN_MANIFEST,
  SPACE_APPLICATIONS,
  recordsPrefix,
  resolveManifestPath,
} from "../src/manifests.js";

assert.equal(resolveManifestPath(FOOD_MANIFEST, "records/meals/"), `${APP_IDS.food}/records/meals/`);
assert.equal(resolveManifestPath(PAIN_MANIFEST, "records/events/"), `${APP_IDS.pain}/records/events/`);
assert.equal(recordsPrefix(APP_IDS.food, "meal"), `${APP_IDS.food}/records/meals/`);
assert.equal(FOOD_MANIFEST.defaults, true);
assert.equal(PAIN_MANIFEST.defaults, true);
assert.equal(INSIGHT_MANIFEST.defaults, true);
assert.equal(INSIGHT_MANIFEST.permissions.some((permission) => permission.path === "" && permission.space === SPACE_APPLICATIONS), true);
assert.equal(resolveManifest(FOOD_MANIFEST).resources.some((permission) => permission.path === `${APP_IDS.food}/`), true);
assert.equal(resolveManifest(PAIN_MANIFEST).resources.some((permission) => permission.path === `${APP_IDS.pain}/`), true);

const result = analyzeCorrelations(
  [{ id: "m1", ts: 1_000, ingredients: ["egg", "wheat"] }],
  [{ id: "p1", ts: 1_000 + 60 * 60 * 1000, severity: 7 }],
);
assert.equal(result.correlations[0].peak, 7);
assert.deepEqual(result.suspiciousIngredients.map((item) => item.name), ["egg", "wheat"]);

assert.deepEqual(normalizeMealDraft({ title: "  Soup ", portion: "huge", ingredients: [" Salt ", "salt"] }), {
  title: "Soup",
  emoji: "🍽",
  ingredients: ["salt"],
  portion: "medium",
  tags: [],
  notes: "",
});
assert.equal(normalizeStoredRecord({ title: "Toast" }, `${APP_IDS.food}/records/meals/meal-mhdf5jxc-abcd12.json`).ts, Number.parseInt("mhdf5jxc", 36));
assert.equal(normalizeStoredRecord({ id: "x", createdAt: "2026-04-29T12:00:00.000Z" }).ts, Date.parse("2026-04-29T12:00:00.000Z"));
assert.equal(normalizeStoredRecord('{"id":"meal-json","title":"Toast","ts":1777470000000}').title, "Toast");
assert.equal(fmtDay("not-a-date"), "Unknown date");
assert.equal(fmtTime("not-a-date"), "unknown time");

console.log("smoke tests passed");
