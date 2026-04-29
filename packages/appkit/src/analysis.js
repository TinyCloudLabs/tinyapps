export function analyzeCorrelations(meals, events, windowHours = 4) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const correlations = meals.map((meal) => {
    const followedBy = events.filter((event) => event.ts > meal.ts && event.ts - meal.ts <= windowMs);
    const peak = followedBy.reduce((max, event) => Math.max(max, event.severity), 0);
    return { meal, followedBy, peak };
  });

  const tally = new Map();
  correlations.forEach((correlation) => {
    if (correlation.peak < 5) return;
    (correlation.meal.ingredients || []).forEach((ingredient) => {
      const current = tally.get(ingredient) || { name: ingredient, count: 0, weighted: 0 };
      current.count += 1;
      current.weighted += correlation.peak;
      tally.set(ingredient, current);
    });
  });

  return {
    correlations,
    suspiciousIngredients: [...tally.values()]
      .sort((a, b) => b.weighted - a.weighted || b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 8),
  };
}

export function normalizeMealDraft(input) {
  const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : "Untitled meal";
  const ingredients = Array.isArray(input?.ingredients)
    ? uniqueStrings(input.ingredients.map((item) => String(item).trim().toLowerCase()).filter(Boolean))
    : [];
  const tags = Array.isArray(input?.tags) ? uniqueStrings(input.tags.map((item) => String(item).trim().toLowerCase()).filter(Boolean)) : [];
  const portion = ["small", "medium", "large"].includes(input?.portion) ? input.portion : "medium";
  return {
    title,
    emoji: typeof input?.emoji === "string" && input.emoji.trim() ? input.emoji.trim() : "🍽",
    ingredients,
    portion,
    tags,
    notes: typeof input?.notes === "string" ? input.notes : "",
  };
}

export function normalizeStoredRecord(input, key = "") {
  const value = parseStoredRecordInput(input);
  const record = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  const fallbackId = key.split("/").pop()?.replace(/\.json$/, "");
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : fallbackId || makeId("record");
  return {
    ...record,
    id,
    ts: normalizeTimestamp(record.ts ?? record.timestamp ?? record.createdAt ?? record.date ?? record.time, id),
  };
}

function parseStoredRecordInput(input) {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function normalizeTimestamp(value, id) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return timestampFromId(id) || Date.now();
}

function timestampFromId(id) {
  const token = typeof id === "string" ? id.split("-")[1] : "";
  const parsed = Number.parseInt(token, 36);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toValidDate(ts) {
  const date = new Date(ts);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function uniqueStrings(items) {
  return [...new Set(items)];
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export function fmtTime(ts) {
  const date = toValidDate(ts);
  return date ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase() : "unknown time";
}

export function fmtDay(ts) {
  const date = toValidDate(ts);
  if (!date) return "Unknown date";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function todayLabel() {
  return new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
}

export function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
