# tinyapps

Real TinyCloud apps for the "anatomy of interoperable apps" talk.

This repo is a workspace for independent TinyCloud apps. It currently contains:

- Food Tracker: logs meals from photos or manual edits.
- Pain Tracker: logs pain events with severity, body location, quality, duration, and notes.
- Insight: an agent-style app that discovers the other app manifests in the TinyCloud `applications` space and correlates meals with pain events.

Each app is its own package under `apps/`. Shared code lives in `packages/appkit`.

The apps are intended to write to real TinyCloud spaces. They do not seed mock records and they do not use a local data simulator. Each app stores its data and manifest under its app-id prefix in the TinyCloud `applications` space.

## Run

```sh
npm install
npm run dev:food
npm run dev:pain
npm run dev:insight
```

Default dev ports:

- Food Tracker: `http://localhost:5173`
- Pain Tracker: `http://localhost:5174`
- Insight: `http://localhost:5175`

## Anthropic Key

Food photo interpretation is served through the Food Tracker app's `/api/analyze-food` route during local development.

Open Food Tracker settings and store your Anthropic API key as `ANTHROPIC_API_KEY` in your TinyCloud secrets vault. The manifest declares read access; saving or deleting the key asks TinyCloud for the extra write/delete permission at runtime.

No shared Anthropic key is used, and no real API key should be committed. Without a user-provided key, Sonnet photo interpretation is unavailable; users can still enter meals manually.

## Cloudflare Pages

Deploy each site as its own Cloudflare Pages project from the repo root:

| Target | Build command | Output directory |
| --- | --- | --- |
| Landing + overview | `npm run build:site` | `dist/site` |
| Food Tracker | `npm run build:food` | `apps/food-tracker/dist` |
| Pain Tracker | `npm run build:pain` | `apps/pain-tracker/dist` |
| Insight | `npm run build:insight` | `apps/insight/dist` |

The app targets are single-page apps. TinyCloud provides identity, manifests,
and user-owned storage, so the apps do not need an app database or app backend
for their core data flows.

Food photo interpretation is the only backend-shaped concern. The local Food
dev server provides `/api/analyze-food` and only accepts the user's
`ANTHROPIC_API_KEY` secret; deployed SPA-only builds can still log meals
manually.

## Spec

See [SPEC.md](./SPEC.md) for app ids, manifests, data paths, and app flow.
