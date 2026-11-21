// Real wallet-signed SIWE CACAOs, encoded as canonical DAG-CBOR, so a renewal receipt is checked the way the SDK
// checks a grant. Adapted from TinyChat's renewalReceipt.fixture.ts. Forges owner-signed leases with viem.
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const DAY = 86_400_000;
export const RENEWER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
export const OTHER_RENEWER = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
export const SESSION_KEY = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf";
export const SPACE_ID = "tinycloud:pkh:eip155:1:space";
const STATEMENT = "I further authorize the stated URI to perform the following actions on my behalf:";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function head(major, n) {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function cbor(value) {
  if (typeof value === "number") return head(0, value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value).map(([key, item]) => [cbor(key), cbor(item)]);
  // DAG-CBOR key order: shorter encoded key first, then bytewise.
  entries.sort(([a], [b]) => a.length - b.length || compare(a, b));
  return [...head(5, entries.length), ...entries.flatMap(([key, item]) => [...key, ...item])];
}

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");

function recapLines(att) {
  let index = 0;
  let lines = "";
  for (const resource of Object.keys(att).sort()) {
    const namespaces = {};
    for (const ability of Object.keys(att[resource]).sort()) {
      const [namespace, name] = ability.split("/");
      (namespaces[namespace] ??= []).push(name);
    }
    for (const namespace of Object.keys(namespaces).sort()) {
      lines += ` (${++index}) '${namespace}': ${namespaces[namespace].map((name) => `'${name}'`).join(", ")} for '${resource}'.`;
    }
  }
  return lines;
}

async function encodeCacao(signer, fields, message) {
  const signature = await signer.signMessage({ message });
  const authorization = base64url(
    cbor({
      h: { t: "eip4361" },
      p: { ...fields, iss: `did:pkh:eip155:1:${signer.address}`, version: 1 },
      s: { t: "eip191", s: Buffer.from(signature.slice(2), "hex") },
    }),
  );
  const { cid } = await parseSignedSiweCacao(authorization);
  return { authorization, cid };
}

async function cacao(signer, { aud, att, iat, exp }) {
  const statement = `${STATEMENT}${recapLines(att)}`;
  const recap = `urn:recap:${base64url(new TextEncoder().encode(JSON.stringify({ att, prf: [] })))}`;
  const nonce = "renewalnonce1234";
  const message = [
    "tinyapps.test wants you to sign in with your Ethereum account:",
    signer.address,
    "",
    statement,
    "",
    `URI: ${aud}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${iat}`,
    `Expiration Time: ${exp}`,
    "Resources:",
    `- ${recap}`,
  ].join("\n");
  return encodeCacao(signer, { domain: "tinyapps.test", aud, nonce, iat, exp, statement, resources: [recap] }, message);
}

/** The CACAO the SDK builds from a SIWE message `signer` signed: same CID as the session grant it produces. */
export async function cacaoFromSiwe(signer, message) {
  const [domainLine, , , ...rest] = message.split("\n");
  const blank = rest.indexOf("");
  const statement = rest.slice(0, blank).join("\n");
  const field = (name) => new RegExp(`^${name}: (.*)$`, "m").exec(message)?.[1];
  const resources = [...message.matchAll(/^- (.*)$/gm)].map((match) => match[1]);
  return encodeCacao(
    signer,
    {
      domain: domainLine.split(" wants you")[0],
      aud: field("URI"),
      nonce: field("Nonce"),
      iat: field("Issued At"),
      exp: field("Expiration Time"),
      statement,
      resources,
    },
    message,
  );
}

/** The Ed25519 public key a `did:key:z6Mk…` names, base64url: what a node publishes as `renewerPublicKey`. */
function didKeyPublicKey(did) {
  let value = 0n;
  for (const char of did.slice("did:key:z".length)) value = value * 58n + BigInt(BASE58.indexOf(char));
  const bytes = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  return base64url(bytes.slice(2));
}

export const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
export const originalEnd = now + 7 * DAY;
const approvedAt = iso(Math.floor(now / 1000) * 1000);

/** The renewal receipt OpenKey returns for the grant `originalCid`. */
export async function leaseReceipt(originalCid, owner, options = {}) {
  const leaseSeconds = options.leaseSeconds ?? 90 * 86_400;
  // `endExtraSeconds` puts the lease end past the lifetime the receipt states (clock slack, or a forgery).
  const leaseEnd = iso(Date.parse(approvedAt) + (leaseSeconds + (options.endExtraSeconds ?? 0)) * 1000);
  const target = `urn:cid:${originalCid}`;
  const lease = await cacao(options.leaseSigner ?? owner, {
    aud: options.leaseAudience ?? RENEWER,
    att: {
      [target]: {
        "tinycloud.delegation/renew": [{}],
        ...(options.extraAbility ? { "tinycloud.delegation/revoke": [{}] } : {}),
      },
    },
    iat: approvedAt,
    exp: leaseEnd,
  });
  const renewer = options.receiptRenewer ?? RENEWER;
  const receipt = {
    version: 1,
    approvedLeaseLifetimeSeconds: leaseSeconds,
    approvedAt: options.approvedAt ?? approvedAt,
    receipt: {
      originalCid,
      leaseCid: lease.cid,
      leaseAuthorization: lease.authorization,
      leaseExpiresAt: leaseEnd,
      leaseGeneration: 1,
      nodeIdentity: { nodeDid: OTHER_RENEWER, renewerDid: renewer, renewerPublicKey: didKeyPublicKey(renewer), renewerEpoch: 0 },
    },
  };
  return { receipt, lease };
}

/** A standalone saved session record and the receipt that renews it, without going through a sign-in. */
export async function fixture(options = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const original = await cacao(owner, {
    aud: SESSION_KEY,
    att: { [`${SPACE_ID}/kv/xyz.tinycloud.tinyapps.pain/records/events/`]: { "tinycloud.kv/get": [{}] } },
    iat: iso(now - DAY),
    exp: iso(originalEnd),
  });
  const record = {
    address: owner.address,
    chainId: 1,
    sessionKey: "{}",
    siwe: "",
    signature: "0x",
    expiresAt: iso(originalEnd),
    createdAt: iso(now - DAY),
    version: "1",
    tinycloudSession: {
      spaceId: SPACE_ID,
      delegationHeader: { Authorization: `Bearer ${original.authorization}` },
      delegationCid: original.cid,
      verificationMethod: SESSION_KEY,
    },
  };
  const { receipt, lease } = await leaseReceipt(original.cid, owner, options);
  return { owner, record, receipt, lease };
}

export { generatePrivateKey, privateKeyToAccount };
