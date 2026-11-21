import assert from "node:assert/strict";

// The SDK reads the sign-in recap with `Buffer`. A browser has none, so importing appkit's TinyCloud module must
// install one: with `Buffer` deleted, loading it brings a working `Buffer` back.
const nodeBuffer = globalThis.Buffer;
delete globalThis.Buffer;
assert.equal(typeof globalThis.Buffer, "undefined");

await import("../src/buffer-global.js");
assert.equal(typeof globalThis.Buffer?.from, "function", "Buffer is installed");
// What the SDK does with the recap payload (it normalizes and pads base64url, then decodes plain base64).
assert.equal(Buffer.from("eyJhIjoxfQ==", "base64").toString("utf8"), '{"a":1}');
assert.equal(Buffer.from('{"a":1}', "utf8").toString("base64"), "eyJhIjoxfQ==");

// An existing `Buffer` is left alone.
globalThis.Buffer = nodeBuffer;
await import("../src/buffer-global.js?again");
assert.equal(globalThis.Buffer, nodeBuffer);

// The TinyCloud module loads it first, so the client it creates always finds one.
const { readFileSync } = await import("node:fs");
const source = readFileSync(new URL("../src/tinycloud.js", import.meta.url), "utf8");
assert.ok(source.startsWith('import "./buffer-global.js";'), "tinycloud.js imports it before anything else");

console.log("buffer global tests passed");
process.exit(0);
