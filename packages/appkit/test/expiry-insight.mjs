import { fileURLToPath } from "node:url";

import { expiryScenarios } from "./support/expiry.mjs";

const { INSIGHT_MANIFEST } = await import("../src/manifests.js");

// Insight: a read past the signed end keeps the screen, shows the prompt, and reads again once after signing in
// again. Insight writes nothing, so "once" is counted as reads: the successful read happens one time.
await expiryScenarios({
  manifest: INSIGHT_MANIFEST,
  actionsFile: fileURLToPath(new URL("../../../apps/insight/src/actions.js", import.meta.url)),
  message: "Your sign-in ended. Sign in again to load your data.",
  writes: 0,
  attempts: 3, // the manifests, the meals and the events are read together
  action: async (actions, tcw) => {
    const data = await actions.loadInsightData(tcw);
    if (!Array.isArray(data.manifests) || !Array.isArray(data.meals) || !Array.isArray(data.events)) throw new Error("no data");
  },
});

console.log("insight expiry tests passed");
process.exit(0);
