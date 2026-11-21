import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import "./support/browser.mjs";

import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { fixture } from "./support/renewal-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../src");

// The Sign out button, wired through the real hook to the real sign-out. JSX is not loadable by Node, so the
// hook and the components are bundled with esbuild (the bundler the apps use) into a temporary module beside
// this file. Only the sign-in itself is replaced by a fake that hands the hook a signed-in session and the
// OpenKey client that signed in.
const bundlePath = join(here, `.renewal-signout-button.${process.pid}.bundle.mjs`);
const bundled = await build({
  stdin: {
    contents: 'export * from "./components.jsx"; export { useTinyCloudApp } from "./useTinyCloudApp.js";',
    resolveDir: src,
    loader: "js",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  packages: "external",
  jsx: "automatic",
  plugins: [
    {
      name: "fake-sign-in",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/tinycloud\.js$/ }, (args) =>
          args.importer.endsWith("useTinyCloudApp.js") ? { path: "fake-sign-in", namespace: "fake" } : undefined,
        );
        buildApi.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
          contents: "export const connectOpenKeyTinyCloud = (...args) => globalThis.__connectOpenKeyTinyCloud(...args);",
          loader: "js",
        }));
      },
    },
  ],
});
writeFileSync(bundlePath, bundled.outputFiles[0].text);

try {
  const { KeepSignedInChoice, SignInScreen, SignOutButton, useTinyCloudApp } = await import(pathToFileURL(bundlePath).href);
  const { KEEP_SIGNED_IN_LABEL, keepSignedInWarning } = await import("../src/renewal.js");
  const { saveRenewalReceipt } = await import("../src/renewal.js");
  const { renewalMayContinueNoticeFor, signedOutNoticeFor } = await import("../src/restore.js");
  const { PAIN_MANIFEST } = await import("../src/manifests.js");

  const exactNotice = (app) =>
    `You're signed out of ${app} in this browser, but OpenKey may still be renewing its access. To stop that, choose Stop renewal under Renewing permissions in OpenKey settings.`;
  assert.equal(renewalMayContinueNoticeFor("Pain Tracker"), exactNotice("Pain Tracker"));
  const confirmedNotice = (app) => `Signed out of ${app} in this browser. ${app}'s access won't renew.`;
  assert.equal(signedOutNoticeFor("Food Tracker"), confirmedNotice("Food Tracker"));

  /** Signs the hook in with a fake sign-in, as the signing tab; resolves the hook's value and the recorded calls. */
  const connectCalls = [];
  async function signedInTab(answer, { appName = "Pain Tracker", signIn = true } = {}) {
    for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
    const { owner, receipt } = await fixture();
    saveRenewalReceipt(PAIN_MANIFEST, owner.address, receipt);
    const order = [];
    const openkey = { signOut: async () => (order.push("openkey.signOut"), answer()) };
    const tcw = { signOut: async () => void order.push("tcw.signOut") };
    globalThis.__connectOpenKeyTinyCloud = async (_manifest, connectOptions) => (connectCalls.push(connectOptions), {
      tcw,
      session: { address: owner.address },
      openkey,
      openKeyAddress: owner.address,
      renewsUntil: receipt.receipt.leaseExpiresAt,
    });
    let auth;
    const Probe = () => {
      auth = useTinyCloudApp(PAIN_MANIFEST, { appName });
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
    for (const appName of ["Pain Tracker", "Insight"]) {
      const { auth, order } = await signedInTab(answer, { appName });
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
  for (const [name, appName] of [["pain-tracker", "Pain Tracker"], ["insight", "Insight"], ["food-tracker", "Food Tracker"]]) {
    assert.match(appSource(name), /<SignOutButton onSignOut=\{auth\.signOut\}/, `${name} has the button`);
    assert.match(appSource(name), /notice=\{auth\.signOutNotice\}/, `${name} shows the notice`);
    assert.ok(appSource(name).includes(`appName: "${appName}"`), `${name} names itself in the notice`);
  }
  assert.match(appSource("food-tracker"), /records="food"/);

  // The choice before connecting: unticked by default, with no warning; ticked it shows the exact warning.
  const label = "Keep me signed in for up to 7 days";
  const warning = (app, records) =>
    `While this is ticked, ${app} can read your ${records} records for up to 7 days without asking you again. Tick it only on a device you trust. You can stop it at any time under Renewing permissions in OpenKey settings.`;
  for (const [appName, records] of [["Pain Tracker", "health"], ["Insight", "health"], ["Food Tracker", "food"]]) {
    const props = { appName, appId: "x", onSignIn() {}, signingIn: false, ...(records === "food" ? { records } : {}) };
    const screen = renderToStaticMarkup(React.createElement(SignInScreen, props, "Title"));
    assert.ok(screen.includes(label), `${appName}: label`);
    assert.match(screen, /<input type="checkbox"(?![^>]*checked)/, `${appName}: unticked by default`);
    assert.equal(screen.includes("While this is ticked"), false, `${appName}: no warning while unticked`);
    const ticked = renderToStaticMarkup(React.createElement(KeepSignedInChoice, { appName, records: props.records, checked: true, onChange() {} }));
    assert.ok(ticked.includes(warning(appName, records)), `${appName}: warning when ticked`);
    assert.equal(keepSignedInWarning(appName, props.records), warning(appName, records));
  }
  assert.equal(KEEP_SIGNED_IN_LABEL, label);

  // The hook asks only for what the person ticked: signIn({ keepSignedIn: true }) is the only way a renewal is requested.
  for (const [argument, expected] of [[{ keepSignedIn: true }, true], [{ keepSignedIn: false }, false], [undefined, false], [{ type: "click" }, false]]) {
    const { auth } = await signedInTab(async () => ({ revoked: true }), { signIn: false });
    await auth.signIn(argument);
    assert.equal(connectCalls.at(-1).keepSignedIn, expected);
  }

  console.log("renewal sign-out button tests passed");
} finally {
  rmSync(bundlePath, { force: true });
}
process.exit(0);
