import { OpenKey, OpenKeyProvider } from "@openkey/sdk";
import { AutoApproveSpaceCreationHandler, TinyCloudWeb } from "@tinycloud/web-sdk";
import { providers } from "ethers";

import { normalizeStoredRecord } from "./analysis.js";
import { SPACE_APPLICATIONS, SPACE_SECRETS, registryPathFor } from "./manifests.js";

const DEFAULT_HOST = "https://node.tinycloud.xyz";
const DEFAULT_OPENKEY_HOST = "https://openkey.so";

export async function connectOpenKeyTinyCloud(manifest, options = {}) {
  const host = options.host || import.meta.env.VITE_TINYCLOUD_HOST || DEFAULT_HOST;
  const openKeyHost = options.openKeyHost || import.meta.env.VITE_OPENKEY_HOST || DEFAULT_OPENKEY_HOST;
  const domain = globalThis.window?.location?.hostname || "tinyapps.local";

  const openkey = new OpenKey({ host: openKeyHost, appName: manifest.name });
  const authResult = await openkey.connect();
  const eip1193Provider = new OpenKeyProvider(openkey, authResult);
  const web3Provider = new providers.Web3Provider(eip1193Provider);

  const tcw = await TinyCloudWeb.create({
    manifest,
    tinycloudHosts: [host],
    domain,
    provider: web3Provider,
    autoCreateSpace: true,
    spacePrefix: SPACE_APPLICATIONS,
    spaceCreationHandler: new AutoApproveSpaceCreationHandler(),
    siweConfig: {
      domain,
      statement: `Sign in to ${manifest.name}.`,
    },
  });
  const session = await tcw.signIn();
  await publishManifest(tcw, manifest);
  return {
    tcw,
    session,
    openkey,
    openKeyAddress: authResult.address,
    openKeyKeyId: authResult.keyId,
  };
}

export async function publishManifest(tcw, manifest) {
  const result = await applicationsKV(tcw).put(registryPathFor(manifest), {
    ...manifest,
    publishedAt: new Date().toISOString(),
  });
  return unwrap(result, `publish ${manifest.id} manifest`);
}

export async function listPublishedManifests(tcw) {
  const list = unwrap(await applicationsKV(tcw).list({ prefix: "", path: "", removePrefix: false }), "list app manifests");
  const keys = uniqueKeys(list.keys || []).filter((key) => key.endsWith("/manifest.json"));
  const manifests = new Map();
  for (const key of keys) {
    const entry = unwrap(await applicationsKV(tcw).get(key), `read ${key}`);
    const manifest = kvValue(entry);
    if (manifest?.id) manifests.set(manifest.id, manifest);
  }
  return [...manifests.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function putRecord(tcw, prefix, record) {
  const result = await applicationsKV(tcw).put(`${prefix}${record.id}.json`, record);
  unwrap(result, `write record ${record.id}`);
  return record;
}

export async function listRecords(tcw, prefix) {
  const list = unwrap(await applicationsKV(tcw).list({ prefix, removePrefix: false }), `list ${prefix}`);
  const keys = uniqueKeys(list.keys || []).filter((key) => key.endsWith(".json"));
  const records = [];
  for (const key of keys) {
    const entry = unwrap(await applicationsKV(tcw).get(key), `read ${key}`);
    records.push(normalizeStoredRecord(kvValue(entry), key));
  }
  return records.sort((a, b) => b.ts - a.ts);
}

function uniqueKeys(keys) {
  return [...new Set(keys)];
}

export async function deleteRecord(tcw, prefix, id) {
  const result = await applicationsKV(tcw).delete(`${prefix}${id}.json`);
  return unwrap(result, `delete record ${id}`);
}

export async function putPhoto(tcw, appId, id, photo) {
  const path = `${appId}/photos/${id}.json`;
  unwrap(await applicationsKV(tcw).put(path, photo), `write photo ${id}`);
  return path;
}

export async function getAnthropicApiKey(tcw) {
  const result = await secretsKV(tcw).get("secrets/anthropic-api-key");
  if (!result.ok) return "";
  const value = kvValue(result.data);
  return typeof value === "string" ? value : "";
}

export async function setAnthropicApiKey(tcw, apiKey) {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    const result = await secretsKV(tcw).delete("secrets/anthropic-api-key");
    if (!result.ok) return undefined;
    return undefined;
  }
  return unwrap(await secretsKV(tcw).put("secrets/anthropic-api-key", trimmed), "store Anthropic API key");
}

export function applicationsKV(tcw) {
  return tcw.space(SPACE_APPLICATIONS).kv;
}

export function secretsKV(tcw) {
  return tcw.space(SPACE_SECRETS).kv;
}

export function unwrap(result, label) {
  if (result?.ok) return result.data;
  const message = result?.error?.message || result?.error?.code || "unknown TinyCloud error";
  throw new Error(`${label} failed: ${message}`);
}

function kvValue(entry) {
  const value = entry && typeof entry === "object" && "data" in entry ? entry.data : entry;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
