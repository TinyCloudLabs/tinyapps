import { parseSignedSiweCacao, pkhDid, principalDidEquals } from "@tinycloud/sdk-core";
import { admitOwnerRenewalLease } from "@tinycloud/sdk-core/delegations/renewal";
import { parseApprovalRenewal } from "@tinycloud/share-envelope/links";
import { BrowserSessionStorage } from "@tinycloud/web-sdk";

// Renewing sign-in. OpenKey signs a renewal lease beside the session the owner approves. OpenKey records it
// but does not send it to the node: right after sign-in the app checks it against the session the sign-in
// just saved, has the session's node admit it, and only then keeps it beside the saved session as the
// session's receipt. It is trusted for nothing until it is checked against that exact saved session. The
// node stays the authority on whether the lease still renews: the SDK's renewal restore asks it before it
// restores anything.

/** The 90-day standing renewal the apps ask OpenKey to offer at sign-in. */
export const SIGN_IN_RENEWAL_ASK = Object.freeze({
  version: 1,
  leaseLifetimeSeconds: 90 * 24 * 60 * 60,
  purpose: "standing",
});

/** How long a signed session lasts; the owner may only shorten it in OpenKey's approval. */
export const SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

const RENEW = "tinycloud.delegation/renew";

/** How long the sign-in waits for the node to admit the lease before going on without renewal. */
const ADMIT_TIMEOUT_MS = 5_000;
/**
 * The latest a lease is sent to the node, after it arrived on this device. A stop at OpenKey leaves a sign-in
 * lease it can't find at the node on for ten minutes, in case the app is still admitting it; this keeps every
 * admission well inside that. Measured on this device's monotonic clock, never against OpenKey's `approvedAt`.
 */
const ADMIT_DEADLINE_MS = 60_000;

/**
 * The OpenKey client the SDK's sign-in calls: adds the renewal ask to OpenKey's request and hands what comes
 * back about renewal to `onOutcome` before the SDK builds the session from the signed result. `openkey` is
 * called as it is passed, so a wrapper that refuses the approval (approval.js) refuses it here first and no
 * outcome is reported.
 */
export function openKeyRenewalClient(openkey, renewal, onOutcome) {
  return {
    authorizeTinyCloud: async (request, opts) => {
      const result = await openkey.authorizeTinyCloud({ ...request, renewal }, opts);
      onOutcome({ renewalChoice: result?.renewalChoice, renewal: result?.renewal });
      return result;
    },
  };
}

/**
 * Each app keeps its saved session apart from the others', so apps served from one origin never restore each
 * other's grants. The renewal receipt key sits outside this prefix: the SDK scans the prefix.
 */
export function appSessionStorage(manifest) {
  return new BrowserSessionStorage({ keyPrefix: `tinyapps:${manifest.app_id}:session:` });
}

const receiptKey = (manifest, address) => `tinyapps:${manifest.app_id}:renewal-receipt:${address.toLowerCase()}`;

/** Keep the renewal receipt OpenKey returned. Unverified here: check it before every use. */
export function saveRenewalReceipt(manifest, address, receipt) {
  try {
    globalThis.localStorage.setItem(receiptKey(manifest, address), JSON.stringify(receipt));
  } catch {
    // localStorage unavailable or full: the session then lasts until its signed end.
  }
}

/** The stored renewal receipt, parsed but unverified; null when there is none or it is unreadable. */
export function loadRenewalReceipt(manifest, address) {
  try {
    const raw = globalThis.localStorage.getItem(receiptKey(manifest, address));
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearRenewalReceipt(manifest, address) {
  try {
    globalThis.localStorage.removeItem(receiptKey(manifest, address));
  } catch {
    // localStorage unavailable
  }
}

const bearerToken = (header) => header.replace(/^Bearer\s+/i, "");

/**
 * The lease authorization in `value` when it is a well-formed receipt for `record`'s own grant, signed by the
 * grant's owner, for that grant only; otherwise null. Never throws.
 */
export async function verifiedRenewalLease(value, record) {
  try {
    const renewal = parseApprovalRenewal(value);
    const { receipt } = renewal;
    const grant = record.tinycloudSession;
    if (!grant || receipt.originalCid !== grant.delegationCid) return null;
    const original = await parseSignedSiweCacao(bearerToken(grant.delegationHeader.Authorization), grant.delegationCid);
    const lease = await parseSignedSiweCacao(receipt.leaseAuthorization, receipt.leaseCid);
    const target = lease.attenuation[`urn:cid:${grant.delegationCid}`];
    const caveats = target?.[RENEW];
    const originalEnd = Date.parse(original.expiresAt ?? "");
    if (
      !principalDidEquals(original.issuer, pkhDid(record.address, record.chainId)) ||
      !principalDidEquals(lease.issuer, original.issuer) ||
      lease.audience !== receipt.nodeIdentity.renewerDid ||
      lease.proofs.length !== 0 ||
      Object.keys(lease.attenuation).length !== 1 ||
      !target ||
      Object.keys(target).length !== 1 ||
      !Array.isArray(caveats) ||
      caveats.length !== 1 ||
      typeof caveats[0] !== "object" ||
      caveats[0] === null ||
      Object.keys(caveats[0]).length !== 0 ||
      Date.parse(lease.expiresAt ?? "") !== Date.parse(receipt.leaseExpiresAt) ||
      !Number.isFinite(originalEnd) ||
      Date.parse(renewal.approvedAt) >= originalEnd
    ) {
      return null;
    }
    return receipt.leaseAuthorization;
  } catch {
    return null;
  }
}

/**
 * Has the signed-in session's node admit the lease OpenKey returned, then keeps it as the session's receipt.
 * The lease must first check out against the session record the sign-in just saved, and is sent only within a
 * minute of `arrivedAt` (a `performance.now()` reading taken when OpenKey returned it). Without a lease, or
 * when the check, the deadline or the admission fails, nothing is kept and no node is contacted for it: the
 * session lasts until its signed end. Resolves the lease's end (ISO time) when renewal is on, else null.
 */
export async function admitSignInRenewal({ tcw, manifest, address, renewal, arrivedAt, storage = appSessionStorage(manifest) }) {
  if (renewal === undefined || renewal === null || arrivedAt === undefined) return null;
  try {
    const record = await storage.load(address);
    const grant = record?.tinycloudSession;
    const leaseAuthorization = record ? await verifiedRenewalLease(renewal, record) : null;
    if (!record || !grant || !leaseAuthorization) return null;
    const { receipt } = parseApprovalRenewal(renewal);
    const { origin } = await tcw.activeNodeIdentity();
    const remaining = arrivedAt + ADMIT_DEADLINE_MS - performance.now();
    if (!(remaining > 0)) return null;
    await admitOwnerRenewalLease({
      host: origin,
      originalAuthorization: bearerToken(grant.delegationHeader.Authorization),
      originalCid: grant.delegationCid,
      ownerDid: pkhDid(record.address, record.chainId),
      agentDid: grant.verificationMethod,
      spaceId: grant.spaceId,
      nodeIdentity: receipt.nodeIdentity,
      leaseAuthorization,
      leaseCid: receipt.leaseCid,
      leaseExpiresAt: receipt.leaseExpiresAt,
      signal: AbortSignal.timeout(Math.min(ADMIT_TIMEOUT_MS, remaining)),
    });
    // A sign-out during the admission cleared the record: keep no receipt beside a session that is gone.
    if ((await storage.load(address))?.tinycloudSession?.delegationCid !== grant.delegationCid) return null;
    saveRenewalReceipt(manifest, address, renewal);
    return receipt.leaseExpiresAt;
  } catch {
    return null;
  }
}

/** The lease end in a stored receipt (epoch milliseconds), or null when the receipt is not readable. */
function leaseEndMs(receipt) {
  try {
    const end = Date.parse(parseApprovalRenewal(receipt).receipt.leaseExpiresAt);
    return Number.isFinite(end) ? end : null;
  } catch {
    return null;
  }
}

/**
 * Restore through the lease only when the saved session is past its signed end and its own receipt checks
 * out. `address` is the saved account (a lapsed session is still a renewal candidate for it). Resolves
 * `{ address, leaseAuthorization, leaseExpiresAt }`, or null: with no receipt the saved session is left for
 * the plain restore. A receipt whose lease end has passed renews nothing: it is dropped here.
 */
export async function renewalRestoreFor(manifest, address, storage = appSessionStorage(manifest)) {
  if (!address) return null;
  const receipt = loadRenewalReceipt(manifest, address);
  if (receipt === null) return null;
  const end = leaseEndMs(receipt);
  if (end !== null && end <= Date.now()) {
    clearRenewalReceipt(manifest, address);
    return null;
  }
  const candidate = await storage.loadRenewalCandidate(address);
  if (candidate.status !== "renewal-candidate") return null;
  const leaseAuthorization = await verifiedRenewalLease(receipt, candidate.data);
  if (!leaseAuthorization) return null;
  return { address, leaseAuthorization, leaseExpiresAt: parseApprovalRenewal(receipt).receipt.leaseExpiresAt };
}

/** The end of the lease kept beside the still-valid saved session of `address`, when its receipt checks out; else null. */
export async function keptLeaseEnd(manifest, address, storage = appSessionStorage(manifest)) {
  try {
    const receipt = loadRenewalReceipt(manifest, address);
    const record = receipt === null ? null : await storage.load(address);
    if (!record || (await verifiedRenewalLease(receipt, record)) === null) return null;
    const end = leaseEndMs(receipt);
    return end !== null && end > Date.now() ? parseApprovalRenewal(receipt).receipt.leaseExpiresAt : null;
  } catch {
    return null;
  }
}
