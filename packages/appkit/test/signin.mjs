import assert from "node:assert/strict";

import "./support/browser.mjs";

const { REENTER_API_KEY_MESSAGE, connectOpenKeyTinyCloud, getAnthropicApiKey } = await import("../src/tinycloud.js");
const { FOOD_MANIFEST } = await import("../src/manifests.js");

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

function fakeOpenKey(authorize) {
  const calls = { connect: 0, authorize: [], signMessage: 0 };
  return {
    calls,
    async connect() {
      calls.connect += 1;
      return { address, keyId: "key_test", keyType: "MANAGED" };
    },
    async authorizeTinyCloud(request, opts) {
      calls.authorize.push({ request, opts });
      return authorize(request);
    },
    async signMessage() {
      calls.signMessage += 1;
      throw new Error("legacy signMessage must not be used for sign-in");
    },
  };
}

const options = { host: "https://node.example.test", openKeyHost: "https://openkey.example.test" };

// Sign-in asks OpenKey through the versioned authorizeTinyCloud request, never byte-exact signMessage.
{
  const openkey = fakeOpenKey(async () => {
    throw new Error("declined in test");
  });
  await assert.rejects(connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }), /declined in test/);
  assert.equal(openkey.calls.connect, 1);
  assert.equal(openkey.calls.authorize.length, 1);
  assert.equal(openkey.calls.signMessage, 0);
  const [{ request, opts }] = openkey.calls.authorize;
  assert.equal(request.protocolVersion, 1);
  assert.equal(opts.mode, "iframe");
  assert.match(request.siwe, new RegExp(`vault/secrets/${FOOD_MANIFEST.secrets && Object.keys(FOOD_MANIFEST.secrets)[0]}`));
  assert.equal("renewal" in request, false);
}

// A declined approval reaches the caller as the error useTinyCloudApp shows, and signs nothing.
{
  const openkey = fakeOpenKey(async () => {
    throw { code: "USER_CANCELLED", message: "User cancelled" };
  });
  await assert.rejects(connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }));
  assert.equal(openkey.calls.signMessage, 0);
}

// A narrowed approval (owner unticked a permission) is refused in plain words and leaves no session.
{
  const narrow = (siwe) => {
    const recap = /urn:recap:([A-Za-z0-9_-]+)/.exec(siwe)[1];
    const payload = JSON.parse(Buffer.from(recap, "base64url").toString());
    const dropped = Object.keys(payload.att).find((resource) => resource.includes(":secrets/kv/vault/secrets/"));
    assert.ok(dropped, "request asks for the secret read");
    delete payload.att[dropped];
    return siwe.replace(recap, Buffer.from(JSON.stringify(payload)).toString("base64url"));
  };
  const openkey = fakeOpenKey(async (request) => ({
    protocolVersion: 1,
    address,
    signature: "0x",
    signedMessage: narrow(request.siwe),
    selectedActionKeys: [],
    permissions: [],
  }));
  await assert.rejects(
    connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }),
    (error) => {
      assert.equal(
        error.message,
        "Food Tracker needs access to your saved Anthropic API key to work. Sign in again and keep all permissions.",
      );
      return true;
    },
  );
  assert.equal(openkey.calls.authorize.length, 1);
}

// A key saved in the previous vault format asks the user to re-enter it; it is not a silent empty key.
{
  const fakeTcw = (error) => ({ secrets: { unlock: async () => ({ ok: true }), get: async () => ({ ok: false, error }) } });
  await assert.rejects(
    getAnthropicApiKey(fakeTcw({ code: "DECRYPTION_FAILED", service: "vault", message: "envelope.v must be 1 (got undefined)" })),
    { message: REENTER_API_KEY_MESSAGE },
  );
  // A key that was never saved stays an empty key.
  assert.equal(await getAnthropicApiKey(fakeTcw({ code: "KEY_NOT_FOUND", service: "vault" })), "");
}

console.log("sign-in tests passed");
process.exit(0);
