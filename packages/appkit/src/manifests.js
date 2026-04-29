export const APP_IDS = {
  food: "xyz.tinycloud.tinyapps.food",
  pain: "xyz.tinycloud.tinyapps.pain",
  insight: "xyz.tinycloud.tinyapps.insight",
};

export const SPACE_APPLICATIONS = "applications";
export const SPACE_SECRETS = "secrets";

export const FOOD_MANIFEST = {
  version: 1,
  id: APP_IDS.food,
  name: "Food Tracker",
  description: "Logs meals, ingredients, and photos in the user's TinyCloud applications space.",
  prefix: APP_IDS.food,
  defaults: true,
  permissions: [
    {
      service: "tinycloud.kv",
      space: SPACE_SECRETS,
      path: "secrets/anthropic-api-key",
      actions: ["get", "put", "del", "metadata"],
      skipPrefix: true,
    },
  ],
  "x-tinyapp": {
    registry: { space: SPACE_APPLICATIONS, path: `${APP_IDS.food}/manifest.json` },
    produces: [
      {
        name: "meal_events",
        service: "tinycloud.kv",
        space: SPACE_APPLICATIONS,
        path: `${APP_IDS.food}/records/meals/`,
        recordType: "meal",
        primaryTimeField: "ts",
        schema: {
          id: "text",
          ts: "integer",
          title: "text",
          emoji: "text",
          ingredients: "string[]",
          portion: "small|medium|large",
          tags: "string[]",
          notes: "text",
          photoPath: "text",
          source: "photo|manual",
        },
      },
    ],
    externalServices: [
      {
        name: "Anthropic Messages API",
        model: "claude-sonnet-4-20250514",
        purpose: "Interpret food photos into editable meal records.",
        secret: "secrets/anthropic-api-key",
      },
    ],
  },
};

export const PAIN_MANIFEST = {
  version: 1,
  id: APP_IDS.pain,
  name: "Pain Tracker",
  description: "Logs pain events in the user's TinyCloud applications space.",
  prefix: APP_IDS.pain,
  defaults: true,
  permissions: [],
  "x-tinyapp": {
    registry: { space: SPACE_APPLICATIONS, path: `${APP_IDS.pain}/manifest.json` },
    produces: [
      {
        name: "pain_events",
        service: "tinycloud.kv",
        space: SPACE_APPLICATIONS,
        path: `${APP_IDS.pain}/records/events/`,
        recordType: "pain",
        primaryTimeField: "ts",
        schema: {
          id: "text",
          ts: "integer",
          severity: "integer 1..10",
          locations: "string[]",
          quality: "string[]",
          duration: "text",
          notes: "text",
        },
      },
    ],
  },
};

export const INSIGHT_MANIFEST = {
  version: 1,
  id: APP_IDS.insight,
  name: "Food × Pain Insight",
  description: "Discovers TinyApps manifests and correlates meals with pain events.",
  prefix: APP_IDS.insight,
  defaults: true,
  permissions: [
    { service: "tinycloud.kv", space: SPACE_APPLICATIONS, path: "", actions: ["get", "list", "metadata"], skipPrefix: true },
    { service: "tinycloud.kv", space: SPACE_APPLICATIONS, path: `${APP_IDS.food}/records/meals/`, actions: ["get", "list"], skipPrefix: true },
    { service: "tinycloud.kv", space: SPACE_APPLICATIONS, path: `${APP_IDS.pain}/records/events/`, actions: ["get", "list"], skipPrefix: true },
  ],
  "x-tinyapp": {
    registry: { space: SPACE_APPLICATIONS, path: `${APP_IDS.insight}/manifest.json` },
    consumes: [
      { appId: APP_IDS.food, dataset: "meal_events", path: `${APP_IDS.food}/records/meals/` },
      { appId: APP_IDS.pain, dataset: "pain_events", path: `${APP_IDS.pain}/records/events/` },
    ],
    produces: [
      {
        name: "food_pain_correlations",
        service: "derived",
        inputs: ["meal_events", "pain_events"],
      },
    ],
  },
};

export const MANIFESTS = {
  food: FOOD_MANIFEST,
  pain: PAIN_MANIFEST,
  insight: INSIGHT_MANIFEST,
};

export function resolveManifestPath(manifest, path, skipPrefix = false) {
  if (skipPrefix || manifest.prefix === "") return path;
  const prefix = manifest.prefix || manifest.id;
  if (path === "/") return `${prefix}/`;
  return path.startsWith("/") ? `${prefix}${path}` : `${prefix}/${path}`;
}

export function registryPathFor(manifest) {
  return `${manifest.id}/manifest.json`;
}

export function recordsPrefix(appId, recordKind) {
  if (recordKind === "meal") return `${appId}/records/meals/`;
  if (recordKind === "pain") return `${appId}/records/events/`;
  throw new Error(`Unknown record kind: ${recordKind}`);
}
