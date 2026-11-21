import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { expiryScenarios } from "./support/expiry.mjs";

const { FOOD_MANIFEST } = await import("../src/manifests.js");
const actionsFile = fileURLToPath(new URL("../../../apps/food-tracker/src/actions.js", import.meta.url));
const message = "Your sign-in ended. Sign in again to save this entry.";
const meal = { title: "Toast", ingredients: ["bread", "butter"], notes: "" };

// Food Tracker, saving a meal: with a photo (the photo and the record are two writes) and without (one write).
for (const [photo, writes] of [["data:image/png;base64,AAAA", 2], ["", 1]]) {
  await expiryScenarios({
    manifest: FOOD_MANIFEST,
    actionsFile,
    message,
    writes,
    action: (actions, tcw) => actions.saveMeal(tcw, { id: "meal-1", createdAt: "2026-01-01T00:00:00.000Z", meal, photo }),
  });
}

// Food Tracker, analyzing a photo: reading the saved key and calling the analysis endpoint past the signed end
// keeps the photo and shows the prompt; after signing in again it analyzes once.
const realFetch = globalThis.fetch;
const analysisCalls = [];
globalThis.fetch = async (url, init) => {
  analysisCalls.push([url, JSON.parse(init.body)]);
  return { ok: true, json: async () => ({ meal }) };
};
try {
  await expiryScenarios({
    manifest: FOOD_MANIFEST,
    actionsFile,
    message,
    writes: 0,
    action: async (actions, tcw) => {
      const draft = await actions.analyzeMeal(tcw, "data:image/png;base64,AAAA");
      assert.equal(draft.title, "Toast");
    },
  });
  // The endpoint was called once per successful run, never with an empty key from the ended session.
  assert.ok(analysisCalls.length > 0);
  assert.ok(analysisCalls.every(([url, body]) => url === "/api/analyze-food" && body.apiKey === "sk-test"));
} finally {
  globalThis.fetch = realFetch;
}

console.log("food expiry tests passed");
process.exit(0);
