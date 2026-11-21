/**
 * Adds the three apps' exact production origins to the first-party origin list inside the installed
 * @tinycloud/web-sdk 3.13.0, so the SDK does not refuse owners who have no registry location record yet
 * ("Finish setting up your TinyCloud account"). Per-deploy preview origins (<hash>.<project>.pages.dev) stay
 * third-party. Sign-in and restore set `autoBootstrapAccount: false`, so account bootstrap and the implicit
 * registry grants stay off: only the refusal lifts.
 *
 * Each origin is a Cloudflare Pages project name; a deleted project's name can be claimed by anyone, so drop its
 * origin here before deleting any of these projects.
 *
 * Pinned to web-sdk 3.13.0. Remove this file (and the postinstall entry) when the SDK fix from TC-3547 /
 * js-sdk #1107 ships; any other version fails the install so the patch is never silently skipped.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PINNED_WEB_SDK_VERSION = "3.13.0";
export const APP_ORIGINS = [
  "https://food-tinyapp.pages.dev",
  "https://pain-tinyapp.pages.dev",
  "https://insight-tinyapp.pages.dev",
];

const originList =
  '["https://tinycloud.chat","https://home.tinycloud.xyz","https://tinycloud.one","tauri://localhost","http://tauri.localhost","https://share.tinycloud.xyz","https://secrets.tinycloud.xyz","https://app.tinycloud.one","tinycloudone://app.tinycloud.one"]';
const originListPatched = `${originList.slice(0, -1)},${APP_ORIGINS.map((origin) => `"${origin}"`).join(",")}]`;

export function addAppFirstPartyOrigins(content) {
  if (content.split(originListPatched).length === 2) return { content, changed: false };
  const parts = content.split(originList);
  if (parts.length !== 2) {
    throw new Error(
      `[first-party-origins] expected the web-sdk ${PINNED_WEB_SDK_VERSION} first-party origin list exactly once, found ${parts.length - 1}`,
    );
  }
  return { content: parts.join(originListPatched), changed: true };
}

export function patchInstalledWebSdk(resolver = createRequire(import.meta.url)) {
  const packageJsonPath = resolver.resolve("@tinycloud/web-sdk/package.json");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (version !== PINNED_WEB_SDK_VERSION) {
    throw new Error(
      `[first-party-origins] @tinycloud/web-sdk is ${version}, this patch is for ${PINNED_WEB_SDK_VERSION}. Remove packages/appkit/scripts/first-party-origins.mjs if the SDK carries the TC-3547 fix, or re-check the patch.`,
    );
  }
  return ["dist/index.mjs", "dist/index.cjs"].map((relativePath) => {
    const filePath = resolve(dirname(packageJsonPath), relativePath);
    if (!existsSync(filePath)) throw new Error(`[first-party-origins] missing ${filePath}`);
    const result = addAppFirstPartyOrigins(readFileSync(filePath, "utf8"));
    if (result.changed) {
      // A package manager may hard-link installed files to a shared cache: write a new file and swap it in,
      // so only this checkout's copy changes.
      const nextPath = `${filePath}.first-party-${process.pid}`;
      writeFileSync(nextPath, result.content, "utf8");
      renameSync(nextPath, filePath);
    }
    return { filePath, status: result.changed ? "patched" : "unchanged" };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { filePath, status } of patchInstalledWebSdk()) {
    if (status === "patched") console.log(`[first-party-origins] Patched: ${filePath}`);
  }
}
