---
name: release-new-version
description: Release a new version of this Obsidian plugin by bumping the npm/package version, syncing `manifest.json` and `versions.json`, and pushing the resulting git tag. Use when the user asks to cut a release, bump the version, publish a new version, or push a release tag.
---

# Release New Version

Use this skill for this repo's release flow.

## Quick flow

1. Make sure the user wants an actual release, not just a local version bump.
2. Check git status and stop if there are unrelated uncommitted changes unless the user explicitly wants to proceed.
3. Ask which version bump to make: `patch`, `minor`, `major`, or an explicit version like `1.3.6`.
4. Run one of:
   - `npm version patch`
   - `npm version minor`
   - `npm version major`
   - `npm version 1.3.6`
5. Push the branch and tag together:
   - `git push origin HEAD --follow-tags`

## What `npm version` does here

- Updates `package.json`.
- Runs the repo's `version` script.
- The `version` script runs `node version-bump.mjs`.
- That script syncs `manifest.json` and `versions.json` to the new version.
- `npm version` also creates a git commit and git tag by default.

## Verify before pushing

- Confirm the new version appears in `package.json` and `manifest.json`.
- Confirm `versions.json` has the new version key.
- Confirm the new commit and tag exist locally.

## Release result

Pushing the tag triggers `.github/workflows/release.yml`, which:

- builds the plugin
- attaches `main.js`, `manifest.json`, `styles.css`, and a zip asset
- creates the GitHub release automatically

## Notes

- Prefer `git push origin HEAD --follow-tags` over pushing the tag separately.
- If the working tree is dirty, ask the user how to proceed before running `npm version`.
