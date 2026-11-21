import { extractRecapAttenuations } from "@tinycloud/sdk-core";

import { APP_IDS, SPACE_APPLICATIONS } from "./manifests.js";

// tinycloud:pkh:eip155:1:0x…:<space>/<service>/<path>
const RESOURCE = /^[^/]*:([^:/]+)\/([^/]+)(?:\/(.*))?$/;

/** Grants in the requested sign-in message that the approved message no longer carries. */
export function narrowedGrants(requestedSiwe, approvedSiwe) {
  const approved = extractRecapAttenuations(approvedSiwe);
  const missing = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(requestedSiwe))) {
    for (const action of Object.keys(actions)) {
      if (approved[resource]?.[action] === undefined) missing.push({ resource, action });
    }
  }
  return missing;
}

function describeGrant(manifest, { resource }) {
  const [, space = "", , path = ""] = RESOURCE.exec(resource) ?? [];
  if (space === "secrets") return "your saved Anthropic API key";
  if (space === SPACE_APPLICATIONS) {
    if (path.startsWith(APP_IDS.food) && manifest.app_id !== APP_IDS.food) return "your Food Tracker records";
    if (path.startsWith(APP_IDS.pain) && manifest.app_id !== APP_IDS.pain) return "your Pain Tracker records";
    return `your ${manifest.name} records`;
  }
  return "your TinyCloud account setup";
}

// Draft copy, the copy owner words it.
export function narrowedApprovalMessage(manifest, missing) {
  const needs = [...new Set(missing.map((grant) => describeGrant(manifest, grant)))];
  const list = needs.length > 1 ? `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}` : needs[0];
  return `${manifest.name} needs access to ${list} to work. Sign in again and keep all permissions.`;
}

/**
 * OpenKey lets the owner untick permissions and the SDK accepts the narrowed session.
 * The apps cannot work with less than they asked for, so refuse before any session exists.
 */
export function refuseNarrowedApproval(openkey, manifest) {
  const authorize = openkey.authorizeTinyCloud.bind(openkey);
  openkey.authorizeTinyCloud = async (request, opts) => {
    const result = await authorize(request, opts);
    const missing = narrowedGrants(request.siwe, result.signedMessage);
    if (missing.length > 0) throw new Error(narrowedApprovalMessage(manifest, missing));
    return result;
  };
  return openkey;
}
