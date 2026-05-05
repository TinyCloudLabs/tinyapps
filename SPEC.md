# TinyApps Spec

## Goal

Build independent health logging apps that interoperate through TinyCloud:

1. Food Tracker logs meals and ingredients.
2. Pain Tracker logs pain events.
3. Insight acts like an agent-generated third app: it discovers manifests in the user's `applications` space, requests/uses compatible read permissions, and correlates food with pain.

The apps should demonstrate the anatomy of interoperable apps:

- Identity: one OpenKey session across all apps.
- Place: the user-owned TinyCloud `applications` space.
- Contract: each app manifest declares steady-state reads; writes outside default scope are runtime permission escalations.
- Discovery: manifests published in the `applications` space tell agents what datasets exist.

## Registry Convention

There is no separate registry inside the default space.

Each independent app publishes its own manifest inside the TinyCloud `applications` space:

```text
space: applications
path:  {appId}/manifest.json
```

Because app data is scoped by app id, this keeps discovery in the application space:

```text
applications/
  xyz.tinycloud.tinyapps.food/
    manifest.json
    records/meals/
    photos/

  xyz.tinycloud.tinyapps.pain/
    manifest.json
    records/events/
    attachments/

  xyz.tinycloud.tinyapps.insight/
    manifest.json
```

An agent lists manifest paths in `applications`, reads each manifest, and derives datasets from the manifest extension metadata.

## App IDs

```text
xyz.tinycloud.tinyapps.food
xyz.tinycloud.tinyapps.pain
xyz.tinycloud.tinyapps.insight
```

## Manifest Shape

The core fields follow the current TinyCloud manifest type:

- `app_id`
- `name`
- `description`
- `prefix`
- `defaults`
- `permissions`
- `secrets`
- optional extension metadata under `x-tinyapp`

The extension is intentionally ignored by the SDK and consumed by agents/apps.

`defaults: true` grants the app its own manifest-scoped data under `{appId}/` in the `applications` space. Explicit permissions are only for data outside that default app scope, such as cross-app reads. Secret manifest entries default to read; saving or deleting a secret relies on SDK permission escalation.

## Food Tracker

### Purpose

Let a user quickly capture what they ate, ideally from a photo. The app uses Claude Sonnet to interpret a food image into structured data, then the user can edit before saving.

### Manifest

```json
{
  "manifest_version": 1,
  "app_id": "xyz.tinycloud.tinyapps.food",
  "name": "Food Tracker",
  "description": "Logs meals, ingredients, and photos in the user's TinyCloud applications space.",
  "prefix": "xyz.tinycloud.tinyapps.food",
  "defaults": true,
  "secrets": {
    "ANTHROPIC_API_KEY": true
  }
}
```

Resolved app-space paths:

```text
xyz.tinycloud.tinyapps.food/manifest.json
xyz.tinycloud.tinyapps.food/records/meals/{mealId}.json
xyz.tinycloud.tinyapps.food/photos/{mealId}.json
```

### KV Records

```text
space: applications
path:  xyz.tinycloud.tinyapps.food/records/meals/{mealId}.json
```

Each meal record contains `id`, `ts`, `title`, `emoji`, `ingredients`, `portion`, `tags`, `notes`, `photoPath`, and `source`.

### Sonnet Image Parsing

The browser sends a base64 image to `/api/analyze-food`. The server reads the API key from:

1. request-provided `ANTHROPIC_API_KEY` from the user's TinyCloud secrets vault, or
2. `ANTHROPIC_API_KEY` environment variable.

Model default:

```text
claude-sonnet-4-20250514
```

The server asks Sonnet to return strict JSON:

```json
{
  "title": "Roasted vegetable bowl with quinoa",
  "emoji": "🥗",
  "ingredients": ["quinoa", "sweet potato", "broccoli"],
  "portion": "medium",
  "tags": ["lunch"],
  "notes": "Optional uncertainty notes"
}
```

Without an API key, the server returns an error. Users can still enter meals manually.

## Pain Tracker

### Purpose

Let a user log pain quickly: severity, where it hurts, what it feels like, duration, and optional notes.

### Manifest

```json
{
  "manifest_version": 1,
  "app_id": "xyz.tinycloud.tinyapps.pain",
  "name": "Pain Tracker",
  "description": "Logs pain events in the user's TinyCloud applications space.",
  "prefix": "xyz.tinycloud.tinyapps.pain",
  "defaults": true,
  "permissions": []
}
```

Resolved app-space paths:

```text
xyz.tinycloud.tinyapps.pain/manifest.json
xyz.tinycloud.tinyapps.pain/records/events/{eventId}.json
xyz.tinycloud.tinyapps.pain/attachments/{eventId}.json
```

### KV Records

```text
space: applications
path:  xyz.tinycloud.tinyapps.pain/records/events/{eventId}.json
```

Each pain record contains `id`, `ts`, `severity`, `locations`, `quality`, `duration`, and `notes`.

## Insight App

### Purpose

Demonstrate agent-level interoperability. Insight does not own food or pain data. It discovers app manifests in the `applications` space, reads the declared datasets, and builds a correlation view.

### Manifest

```json
{
  "manifest_version": 1,
  "app_id": "xyz.tinycloud.tinyapps.insight",
  "name": "Food × Pain Insight",
  "description": "Discovers TinyApps manifests and correlates meals with pain events.",
  "prefix": "xyz.tinycloud.tinyapps.insight",
  "defaults": true,
  "permissions": [
    { "service": "tinycloud.kv", "space": "applications", "path": "", "actions": ["get", "list", "metadata"], "skipPrefix": true },
    { "service": "tinycloud.kv", "space": "applications", "path": "xyz.tinycloud.tinyapps.food/records/meals/", "actions": ["get", "list"], "skipPrefix": true },
    { "service": "tinycloud.kv", "space": "applications", "path": "xyz.tinycloud.tinyapps.pain/records/events/", "actions": ["get", "list"], "skipPrefix": true }
  ]
}
```

### Correlation Logic

For each meal, find pain events that occur after the meal and within four hours.

Then:

- compute peak pain severity after each meal,
- tally ingredients from meals followed by pain severity >= 5,
- show the discovered source manifests and dataset paths.

The output must say it is a pattern, not a diagnosis.

## Design

The UI follows the supplied example app bundle:

- warm paper theme,
- editorial serif display type,
- mobile-first app shells,
- bottom navigation,
- floating capture/log button,
- OpenKey consent sheet,
- app-specific accent colors:
  - food: terracotta,
  - pain: ochre,
  - insight: sage.

The real implementation may use system font fallbacks if Google Fonts are unavailable.

## Repository Layout

```text
apps/
  food-tracker/
  pain-tracker/
  insight/
packages/
  appkit/
```

New apps should be added as separate packages under `apps/`, with shared TinyCloud and UI helpers kept in `packages/appkit` only when they are genuinely reusable.

## Non-Goals

- No committed secrets.
- No medical diagnosis.
- No shared `health.sqlite`; the point is app independence plus manifest-based discovery.
- No mock or seeded user records.
