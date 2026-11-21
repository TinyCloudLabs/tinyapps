import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expiryScenarios } from "./support/expiry.mjs";

const { PAIN_MANIFEST } = await import("../src/manifests.js");

// Pain Tracker: a save past the signed end keeps the entry, shows the prompt, and saves it once after signing in again.
await expiryScenarios({
  manifest: PAIN_MANIFEST,
  actionsFile: fileURLToPath(new URL("../../../apps/pain-tracker/src/actions.js", import.meta.url)),
  message: "Your sign-in ended. Sign in again to save this entry.",
  writes: 1,
  action: (actions, tcw) => actions.savePainEvent(tcw, { severity: 6, locations: ["back-low"], quality: ["dull"], duration: "an hour", notes: "after lunch" }),
});

console.log("pain expiry tests passed");
process.exit(0);
