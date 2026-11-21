import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { APP_ORIGINS, addAppFirstPartyOrigins } from "../scripts/first-party-origins.mjs";

const originList =
  '["https://tinycloud.chat","https://home.tinycloud.xyz","https://tinycloud.one","tauri://localhost","http://tauri.localhost","https://share.tinycloud.xyz","https://secrets.tinycloud.xyz","https://app.tinycloud.one","tinycloudone://app.tinycloud.one"]';

// The patch appends exactly the three production origins, once, and refuses an SDK build whose list differs.
const first = addAppFirstPartyOrigins(`x=new Set(${originList}),y=1`);
assert.equal(first.changed, true);
assert.equal(
  first.content,
  `x=new Set(${originList.slice(0, -1)},"https://food-tinyapp.pages.dev","https://pain-tinyapp.pages.dev","https://insight-tinyapp.pages.dev"]),y=1`,
);
assert.deepEqual(addAppFirstPartyOrigins(first.content), { content: first.content, changed: false });
assert.throws(() => addAppFirstPartyOrigins('x=new Set(["https://tinycloud.chat"])'), /first-party origin list exactly once/);

const fixture = fileURLToPath(new URL("./support/sign-in-policy.mjs", import.meta.url));
function policyAt(origin) {
  const run = spawnSync(process.execPath, [fixture, origin], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
}

const bootstrapOff = { autoBootstrapAccount: false, includeAccountRegistryPermissions: false, includeImplicitCapabilitiesRead: false };

// On each app's production origin an owner without a location record is not refused, and bootstrap stays off
// for both sign-in and restore.
for (const origin of APP_ORIGINS) {
  const { signIn, restore } = policyAt(origin);
  assert.deepEqual(signIn, { ...bootstrapOff, requireExistingAccount: false }, origin);
  assert.deepEqual(restore, { ...bootstrapOff, requireExistingAccount: false }, origin);
}

// Per-deploy preview origins keep the existing-account check.
for (const origin of ["https://0123abcd.food-tinyapp.pages.dev", "https://evil-food-tinyapp.pages.dev"]) {
  assert.deepEqual(policyAt(origin).signIn, { ...bootstrapOff, requireExistingAccount: true }, origin);
}

console.log("first-party origin tests passed");
