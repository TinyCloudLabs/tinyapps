import { APP_IDS, listPublishedManifests, listRecords, recordsPrefix } from "@tinyapps/appkit";

const MEALS_PREFIX = recordsPrefix(APP_IDS.food, "meal");
const EVENTS_PREFIX = recordsPrefix(APP_IDS.pain, "pain");

/** Everything Insight reads: the published manifests, the meals and the pain events. */
export async function loadInsightData(tcw) {
  const [manifests, meals, events] = await Promise.all([
    listPublishedManifests(tcw),
    listRecords(tcw, MEALS_PREFIX),
    listRecords(tcw, EVENTS_PREFIX),
  ]);
  return { manifests, meals, events };
}
