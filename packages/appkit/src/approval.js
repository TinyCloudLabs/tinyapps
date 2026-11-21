import { extractRecapAttenuations } from "@tinycloud/sdk-core";

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

// Copy from the copy owner.
export function narrowedApprovalMessage(manifest) {
  return `${manifest.name} needs all the permissions it asks for. Sign in again and allow each one.`;
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
    if (missing.length > 0) throw new Error(narrowedApprovalMessage(manifest));
    return result;
  };
  return openkey;
}
