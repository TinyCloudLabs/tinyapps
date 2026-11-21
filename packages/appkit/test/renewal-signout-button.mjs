import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import "./support/browser.mjs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { bundle } from "./support/bundle.mjs";
import { fixture } from "./support/renewal-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../src");

// The Sign out button, wired through the real hook to the real sign-out. The hook and the components are bundled
// (see support/bundle.mjs); only the sign-in itself is replaced, by a fake that hands the hook a signed-in session
// and the OpenKey client that signed in.
const { module: appkit, cleanup } = await bundle(
  'export * from "./components.jsx"; export { useTinyCloudApp } from "./useTinyCloudApp.js";',
  src,
);

try {
  const { SignInScreen, SignOutButton, useTinyCloudApp } = appkit;
  const { saveRenewalReceipt } = await import("../src/renewal.js");
  const { renewalMayContinueNoticeFor, signedOutNoticeFor } = await import("../src/restore.js");
  const { FOOD_MANIFEST, INSIGHT_MANIFEST, PAIN_MANIFEST } = await import("../src/manifests.js");

  const exactNotice = (app) =>
    `You're signed out of ${app} in this browser, but OpenKey may still be renewing its access. To stop that, choose Stop renewal under Renewing permissions in OpenKey settings.`;
  assert.equal(renewalMayContinueNoticeFor("Pain Tracker"), exactNotice("Pain Tracker"));
  const confirmedNotice = (app) => `Signed out of ${app} in this browser. ${app}'s access won't renew.`;
  assert.equal(signedOutNoticeFor("Food Tracker"), confirmedNotice("Food Tracker"));

  /** Signs the hook in with a fake sign-in, as the signing tab; resolves the hook's value and the recorded calls. */
  async function signedInTab(answer, { manifest = PAIN_MANIFEST, signIn = true } = {}) {
    for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
    const { owner, receipt } = await fixture();
    saveRenewalReceipt(PAIN_MANIFEST, owner.address, receipt);
    const order = [];
    const openkey = { signOut: async () => (order.push("openkey.signOut"), answer()) };
    const tcw = { signOut: async () => void order.push("tcw.signOut") };
    globalThis.__connectOpenKeyTinyCloud = async (_manifest) => ({
      tcw,
      session: { address: owner.address },
      openkey,
      openKeyAddress: owner.address,
      renewsUntil: receipt.receipt.leaseExpiresAt,
    });
    let auth;
    const Probe = () => {
      auth = useTinyCloudApp(manifest);
      return null;
    };
    renderToStaticMarkup(React.createElement(Probe));
    // Signed out: no session to end, nothing asked of OpenKey.
    assert.equal(await auth.signOut(), null);
    assert.deepEqual(order, []);
    if (signIn) await auth.signIn();
    return { auth, owner, order };
  }

  // The button is a "Sign out" control that runs the hook's signOut.
  {
    const { auth, order } = await signedInTab(async () => ({ revoked: true }));
    const markup = renderToStaticMarkup(React.createElement(SignOutButton, { onSignOut: auth.signOut, signingOut: false }));
    assert.match(markup, /^<button[^>]*>.*Sign out<\/button>$/);
    const element = SignOutButton({ onSignOut: auth.signOut, signingOut: false });
    assert.equal(element.type, "button");
    assert.match(renderToStaticMarkup(React.createElement(SignOutButton, { onSignOut: auth.signOut, signingOut: true })), /disabled/);
    // Pressing it asks OpenKey to end its session first, then signs out locally.
    assert.equal(await element.props.onClick(), confirmedNotice("Pain Tracker"), "revoked true: the confirmed notice");
    assert.deepEqual(order, ["openkey.signOut", "tcw.signOut"]);
  }

  // Revoked true gives the confirmed notice; any other answer gives the unconfirmed one, each with the exact text for the app it names.
  for (const [label, answer, shown] of [
    ["revoked true", async () => ({ revoked: true }), false],
    ["revoked false", async () => ({ revoked: false }), true],
    ["OpenKey throws", async () => Promise.reject(new Error("popup blocked")), true],
    ["user cancels", async () => Promise.reject({ code: "USER_CANCELLED" }), true],
  ]) {
    // The notices name the app as OpenKey shows it: the manifest name (Insight is "Food × Pain Insight").
    for (const manifest of [PAIN_MANIFEST, INSIGHT_MANIFEST, FOOD_MANIFEST]) {
      const appName = manifest.name;
      const { auth, order } = await signedInTab(answer, { manifest });
      const notice = await SignOutButton({ onSignOut: auth.signOut }).props.onClick();
      assert.equal(notice, shown ? exactNotice(appName) : confirmedNotice(appName), `${label} (${appName})`);
      assert.deepEqual(order, ["openkey.signOut", "tcw.signOut"], label);
      // The sign-in screen the person lands on shows the notice.
      const screen = (text) =>
        renderToStaticMarkup(React.createElement(SignInScreen, { appName, appId: "x", onSignIn() {}, signingIn: false, notice: text }, "Title"));
      const escaped = (text) => text.replaceAll("'", "&#x27;");
      assert.ok(screen(notice).includes(escaped(notice)), `${label}: notice markup`);
      assert.equal(screen(notice).includes("may still be renewing"), shown);
      assert.equal(screen(null).includes("may still be renewing") || screen(null).includes("won&#x27;t renew"), false);
    }
  }

  // All three apps carry the button and show the notice on the sign-in screen, under the name in their header.
  const appSource = (name) => readFileSync(join(here, `../../../apps/${name}/src/main.jsx`), "utf8");
  for (const name of ["pain-tracker", "insight", "food-tracker"]) {
    assert.match(appSource(name), /<SignOutButton onSignOut=\{auth\.signOut\}/, `${name} has the button`);
    assert.match(appSource(name), /notice=\{auth\.signOutNotice\}/, `${name} shows the notice`);
  }

  // No choice and no extra line on the sign-in screen: OpenKey's own box decides, once.
  const screen = renderToStaticMarkup(React.createElement(SignInScreen, { appName: "Pain Tracker", appId: "x", onSignIn() {}, signingIn: false }, "Title"));
  assert.doesNotMatch(screen, /checkbox|Keep me signed in|While this is ticked|OpenKey will ask/);
  assert.equal([...screen.matchAll(/<button/g)].length, 1, "one button: Sign in with OpenKey");

  console.log("renewal sign-out button tests passed");
} finally {
  cleanup();
}
process.exit(0);
