import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import "./browser.mjs";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { bundle } from "./bundle.mjs";
import { mountHook } from "./host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const appkitSrc = join(here, "../../src");

const endedError = () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "Unauthorized", meta: { status: 401 } } });
const serverError = () => ({ ok: false, error: { code: "NETWORK_ERROR", message: "node unavailable", meta: { status: 500 } } });

/**
 * A stand-in for the signed-in SDK client. `mode` is what the node answers every request with: "ok", "ended" (the
 * session is past its signed end: the node's 401 `AUTH_UNAUTHORIZED`, what the real SDK reports) or "server" (a
 * failure that is not about the session). It records every write and counts every attempt.
 */
export function fakeClient(mode = "ok") {
  const client = { mode, writes: [], attempts: 0, store: new Map() };
  const gate = () => {
    client.attempts += 1;
    if (client.mode === "ended") return endedError();
    if (client.mode === "server") return serverError();
    return null;
  };
  const kv = {
    put: async (key, value) => gate() ?? (client.writes.push(key), client.store.set(key, value), { ok: true, data: undefined }),
    get: async (key) => gate() ?? { ok: true, data: client.store.get(key) },
    list: async () => gate() ?? { ok: true, data: { keys: [...client.store.keys()] } },
    delete: async (key) => gate() ?? (client.store.delete(key), { ok: true, data: undefined }),
  };
  client.space = () => ({ kv });
  client.secrets = { unlock: async () => gate() ?? { ok: true, data: undefined }, get: async () => gate() ?? { ok: true, data: "sk-test" } };
  client.signOut = async () => undefined;
  client.cleanup = () => undefined;
  return client;
}

/**
 * The expiry-mid-entry behaviour of one app, with that app's real action module (bundled, see ./bundle.mjs) and the
 * real hook and prompt. `config.action(actions, tcw)` is what the app's screen runs through `runWithSession` for
 * the entry; `config.writes` is how many writes one entry makes; `config.attempts` is how many requests one run of
 * the action sends before it fails (1, or 3 where the reads go out together); `config.address` is the OpenKey account.
 */
export async function expiryScenarios(config) {
  const { manifest, actionsFile, action, writes, message, attempts = 1, address = "0x1111111111111111111111111111111111111111" } = config;
  const { module: app, cleanup } = await bundle(
    `export { useTinyCloudApp } from "./useTinyCloudApp.js"; export { SessionEndedPrompt, SESSION_ENDED_MESSAGE } from "./components.jsx"; export * as actions from ${JSON.stringify(actionsFile)};`,
    appkitSrc,
  );
  const escaped = (text) => text.replaceAll("'", "&#x27;");
  try {
    const connects = [];
    const connectAnswers = [];
    globalThis.__connectOpenKeyTinyCloud = async () => {
      connects.push(1);
      const answer = connectAnswers.shift();
      if (answer instanceof Error || (answer && !answer.tcw)) throw answer;
      return { tcw: answer.tcw, session: { address }, openkey: { signOut: async () => ({ revoked: true }) }, openKeyAddress: address, renewsUntil: null };
    };

    async function start() {
      connects.length = 0;
      const first = fakeClient("ok");
      connectAnswers.push({ tcw: first });
      const hook = await mountHook(() => app.useTinyCloudApp(manifest));
      await hook.run(() => hook.value.signIn());
      assert.equal(hook.value.tcw, first, "signed in");
      connects.length = 0;
      let followed = 0;
      // What the screen runs: the write or read, then what follows it (the screen going home); a retry repeats both.
      const entry = async (tcw) => {
        await action(app.actions, tcw);
        followed += 1;
      };
      let result;
      const press = async () => hook.run(async () => void (result = await hook.value.runWithSession(entry)));
      const markup = () => renderToStaticMarkup(React.createElement(app.SessionEndedPrompt, { auth: hook.value }, message));
      return { hook, first, entry, followed: () => followed, press, result: () => result, markup };
    }

    // A write past the signed end keeps the entry: nothing is lost, nothing runs after it, the prompt shows with
    // its button, and the session screen is still there.
    {
      const { hook, first, followed, press, result, markup } = await start();
      first.mode = "ended";
      await press();
      assert.deepEqual(result(), { done: false });
      assert.equal(first.attempts, attempts, "tried once");
      assert.equal(first.writes.length, 0);
      assert.equal(followed(), 0, "the screen did not go on as if it had saved");
      assert.equal(hook.value.expired, true);
      assert.ok(hook.value.session && hook.value.tcw === first, "still on the entry screen, session not cleared");
      assert.equal(hook.value.error, "");
      assert.equal(connects.length, 0, "nothing signs in without the person pressing");
      const html = markup();
      assert.ok(html.includes(escaped(message)), "the prompt text");
      assert.ok(html.includes("Sign in again"), "the button");
      assert.ok(escaped(message).startsWith("Your sign-in ended. Sign in again to"));
      await hook.unmount();
    }

    // "Sign in again" signs in in place and saves the kept entry exactly once, on the new session.
    {
      const { hook, first, followed, press, markup } = await start();
      first.mode = "ended";
      await press();
      const second = fakeClient("ok");
      connectAnswers.push({ tcw: second });
      let resumed;
      await hook.run(async () => void (resumed = await hook.value.resume()));
      assert.deepEqual(resumed.done, true);
      assert.equal(connects.length, 1, "one sign-in");
      assert.equal(second.writes.length, writes, "the entry saved once on the new session");
      assert.equal(first.writes.length, 0);
      assert.equal(first.attempts, attempts, "the old session was not tried again");
      assert.equal(followed(), 1);
      assert.equal(hook.value.tcw, second);
      assert.equal(hook.value.expired, false);
      assert.equal(hook.value.error, "");
      assert.equal(markup(), "", "no prompt once saved");
      // Pressing again does not save it a second time.
      await hook.run(() => hook.value.resume());
      assert.equal(second.writes.length, writes);
      await hook.unmount();
    }

    // Sign-in fails or is cancelled: the entry is still kept (the prompt stays with the reason), nothing is
    // saved, and a later "Sign in again" still saves it once.
    for (const refusal of [new Error("popup blocked"), Object.assign(new Error("Sign-in was cancelled"), { code: "USER_CANCELLED" })]) {
      const { hook, first, followed, press, markup } = await start();
      first.mode = "ended";
      await press();
      connectAnswers.push(refusal);
      let resumed;
      await hook.run(async () => void (resumed = await hook.value.resume()));
      assert.deepEqual(resumed, { done: false });
      assert.equal(hook.value.expired, true, "still ended, entry kept");
      assert.equal(hook.value.error, refusal.message);
      assert.ok(hook.value.tcw === first && hook.value.session);
      assert.equal(followed(), 0);
      const html = markup();
      assert.ok(html.includes(escaped(message)) && html.includes(escaped(refusal.message)) && html.includes("Sign in again"));
      const second = fakeClient("ok");
      connectAnswers.push({ tcw: second });
      await hook.run(() => hook.value.resume());
      assert.equal(second.writes.length, writes, "saved once after signing in again");
      assert.equal(followed(), 1);
      assert.equal(hook.value.error, "");
      await hook.unmount();
    }

    // The one retry fails (for any reason, even the new session ending): the error is shown, the action is not
    // tried a third time, and nothing loops.
    for (const mode of ["server", "ended"]) {
      const { hook, first, followed, press, markup } = await start();
      first.mode = "ended";
      await press();
      const second = fakeClient(mode);
      connectAnswers.push({ tcw: second });
      let resumed;
      await hook.run(async () => void (resumed = await hook.value.resume()));
      assert.deepEqual(resumed, { done: false });
      assert.equal(second.attempts, attempts, `${mode}: the retry ran exactly once`);
      assert.equal(connects.length, 1);
      assert.equal(second.writes.length, 0);
      assert.equal(followed(), 0);
      assert.ok(hook.value.error.length > 0, `${mode}: the error is shown`);
      assert.equal(hook.value.expired, false);
      assert.ok(markup().includes(escaped(hook.value.error)));
      await hook.unmount();
    }

    // An error that is not about the session keeps the app's usual error display: it is thrown to the caller, no
    // prompt shows and nothing signs in.
    {
      const { hook, first, entry } = await start();
      first.mode = "server";
      let thrown;
      await hook.run(async () => {
        try {
          await hook.value.runWithSession(entry);
        } catch (err) {
          thrown = err;
        }
      });
      assert.ok(thrown instanceof Error && /node unavailable|unavailable/.test(thrown.message), "the caller gets the error");
      assert.equal(hook.value.expired, false);
      assert.equal(hook.value.error, "");
      assert.equal(renderToStaticMarkup(React.createElement(app.SessionEndedPrompt, { auth: hook.value }, message)), "", "no prompt");
      assert.equal(connects.length, 0);
      await hook.unmount();
    }

    // A signed-in session that has not ended runs the action once, with nothing kept.
    {
      const { hook, first, followed, press, result } = await start();
      await press();
      assert.equal(result().done, true);
      assert.equal(first.writes.length, writes);
      assert.equal(followed(), 1);
      assert.equal(hook.value.expired, false);
      await hook.unmount();
    }
    return { app };
  } finally {
    cleanup();
    delete globalThis.__connectOpenKeyTinyCloud;
  }
}
