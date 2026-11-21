import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture } from "./support/renewal-fixture.mjs";

const { getAnthropicApiKey, setAnthropicApiKey, SECRETS_ACCOUNT_MESSAGE, SECRETS_UNLOCK_MESSAGE } = await import("../src/tinycloud.js");
const { restoreSavedSession } = await import("../src/restore.js");
const { FOOD_MANIFEST } = await import("../src/manifests.js");

// A restored session has no OpenKey client, so no secrets signer. Reading or saving the Anthropic key after a
// reload asks OpenKey (a fresh client) to confirm, as sign-in does, and fails with a plain message when it
// cannot: it never resolves to an empty key. The SDK client is a fake whose `secrets.unlock` calls the signer
// the way the real one does and reports a failure as a result.

async function restoredTab({ connect, createOpenKeyThrows = false } = {}) {
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
  const { owner, record } = await fixture();
  const seen = { created: 0, connects: 0, signed: [], secretsGet: 0, secretsPut: 0 };
  const tcw = {
    restoreSession: async () => ({ status: "restored", session: { address: owner.address } }),
    cleanup() {},
    secrets: {
      unlock: async (signer) => {
        try {
          const signature = await signer.signMessage("unlock-message");
          assert.equal(signature, "0xsig");
          return { ok: true, data: undefined };
        } catch (error) {
          return { ok: false, error: { message: error.message } };
        }
      },
      get: async () => (seen.secretsGet += 1, { ok: true, data: { data: "sk-ant-test" } }),
      put: async () => (seen.secretsPut += 1, { ok: true, data: undefined }),
    },
  };
  const storage = {
    activeAddress: () => owner.address,
    activeAddressForRenewal: () => owner.address,
    loadRenewalCandidate: async () => ({ status: "loaded", data: record }),
    clear: async () => undefined,
  };
  const createOpenKey = () => {
    seen.created += 1;
    if (createOpenKeyThrows) throw new Error("no openkey");
    return {
      connect: async () => (seen.connects += 1, connect(owner)),
      signMessage: async ({ message, keyId }) => (seen.signed.push({ message, keyId }), { signature: "0xsig" }),
    };
  };
  const outcome = await restoreSavedSession(FOOD_MANIFEST, { storage, createClient: async () => tcw, isOffline: () => false, createOpenKey });
  assert.equal(outcome.kind, "restored");
  return { tcw: outcome.tcw, owner, seen };
}

// The saved account unlocks: OpenKey is asked only when secrets are first used, once, and the key is read.
{
  const { tcw, seen } = await restoredTab({ connect: async (owner) => ({ address: owner.address.toUpperCase().replace("0X", "0x"), keyId: "key-1" }) });
  assert.equal(seen.created, 0, "restoring does not ask OpenKey");
  assert.equal(await getAnthropicApiKey(tcw), "sk-ant-test");
  assert.equal(await getAnthropicApiKey(tcw), "sk-ant-test");
  await setAnthropicApiKey(tcw, "sk-ant-new");
  assert.equal(seen.created, 1);
  assert.equal(seen.connects, 1, "one OpenKey connection serves every use");
  assert.deepEqual(seen.signed[0], { message: "unlock-message", keyId: "key-1" });
  assert.equal(seen.secretsPut, 1);
}

// A different OpenKey account fails with a plain message and reads nothing.
{
  const { tcw, seen } = await restoredTab({ connect: async () => ({ address: "0x0000000000000000000000000000000000000001", keyId: "k" }) });
  await assert.rejects(getAnthropicApiKey(tcw), (error) => error.message.includes(SECRETS_ACCOUNT_MESSAGE));
  await assert.rejects(setAnthropicApiKey(tcw, "sk-ant-new"), (error) => error.message.includes(SECRETS_ACCOUNT_MESSAGE));
  assert.equal(seen.signed.length, 0);
  assert.equal(seen.secretsGet + seen.secretsPut, 0);
}

// OpenKey that is declined, or cannot be built, fails with a plain message, never an empty key; a later try asks again.
{
  let attempt = 0;
  const { tcw, seen } = await restoredTab({
    connect: async (owner) => {
      if (attempt++ === 0) throw { code: "USER_CANCELLED" };
      return { address: owner.address, keyId: "key-2" };
    },
  });
  await assert.rejects(getAnthropicApiKey(tcw), (error) => error.message.includes(SECRETS_UNLOCK_MESSAGE));
  assert.equal(seen.secretsGet, 0);
  assert.equal(await getAnthropicApiKey(tcw), "sk-ant-test", "the next try asks OpenKey again");
  assert.equal(seen.connects, 2);
}
{
  const { tcw, seen } = await restoredTab({ connect: async () => ({}), createOpenKeyThrows: true });
  await assert.rejects(getAnthropicApiKey(tcw), (error) => error.message.includes(SECRETS_UNLOCK_MESSAGE));
  assert.equal(seen.secretsGet, 0);
}

console.log("renewal secrets tests passed");
process.exit(0);
