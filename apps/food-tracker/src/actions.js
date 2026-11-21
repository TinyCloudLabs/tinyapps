import { APP_IDS, getAnthropicApiKey, listRecords, normalizeMealDraft, putPhoto, putRecord, recordsPrefix } from "@tinyapps/appkit";

const MEALS_PREFIX = recordsPrefix(APP_IDS.food, "meal");

export const loadMeals = (tcw) => listRecords(tcw, MEALS_PREFIX);

/** Asks the analysis endpoint to read a meal photo with the saved Anthropic key; resolves the meal draft. */
export async function analyzeMeal(tcw, photo) {
  const apiKey = await getAnthropicApiKey(tcw);
  const response = await fetch("/api/analyze-food", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: photo, apiKey }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Food analysis failed");
  return normalizeMealDraft(payload.meal);
}

/** Writes one meal (and its photo): `id` and `createdAt` are fixed by the caller, so a second try writes the same entry. */
export async function saveMeal(tcw, { id, createdAt, meal, photo }) {
  const photoPath = photo ? await putPhoto(tcw, APP_IDS.food, id, { id, dataUrl: photo, createdAt }) : "";
  return putRecord(tcw, MEALS_PREFIX, { ...meal, id, ts: Date.now(), createdAt, photoPath, source: photo ? "photo" : "manual" });
}
