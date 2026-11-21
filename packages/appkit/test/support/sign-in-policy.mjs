// Prints the installed web-sdk's sign-in policy for the apps' sign-in and restore clients at the origin in argv[2].
// Runs in its own process so the page origin is set before anything reads it.
import "./browser.mjs";

const origin = process.argv[2];
globalThis.window.location = { host: new URL(origin).host, hostname: new URL(origin).hostname, origin };

const { TinyCloudWeb } = await import("@tinycloud/web-sdk");
const { connectOpenKeyTinyCloud } = await import("../../src/tinycloud.js");
const { createRestoreClient } = await import("../../src/restore.js");
const { FOOD_MANIFEST } = await import("../../src/manifests.js");

const address = "0x0000000000000000000000000000000000000001";
const STOP = new Error("policy captured");
let captured;
TinyCloudWeb.create = async (config) => {
  captured = new TinyCloudWeb(config).bootstrapSignInPolicy();
  throw STOP;
};
const capture = async (start) => {
  captured = undefined;
  try {
    await start();
  } catch (error) {
    if (error !== STOP) throw error;
  }
  return captured;
};

const openkey = {
  connect: async () => ({ address, chainId: 1 }),
  authorizeTinyCloud: async () => {
    throw new Error("not reached");
  },
};
const signIn = await capture(() => connectOpenKeyTinyCloud(FOOD_MANIFEST, { host: "https://node.example.test", openkey }));
const restore = await capture(() => createRestoreClient(FOOD_MANIFEST, address, { host: "https://node.example.test" }));

console.log(JSON.stringify({ signIn, restore }));
process.exit(0);
