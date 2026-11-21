// The TinyCloud SDK decodes the sign-in recap with Node's `Buffer`, which a browser bundle lacks. The explicit file
// makes the bundler take the `buffer` package, not the Node builtin (a bare "buffer" is externalized).
import { Buffer } from "buffer/index.js";

globalThis.Buffer ??= Buffer;
