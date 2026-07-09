# Viscap — Publish Stitch (dev plugin)

Builds a feature's resolved Figma layout spec (from pm-app) into the currently
open Figma file, as real antd library instances.

## Install (once)
1. `npm run plugin:build` (from repo root) — produces `figma-plugin/code.js`.
2. Figma desktop → Plugins → Development → **Import plugin from manifest…** →
   pick `figma-plugin/manifest.json`.

## Use
1. In pm-app's Feature Editor, open **Design → Figma** and click
   **Copy Publish Payload**.
2. Create/open the feature's Figma file in the correct Application project.
3. Run the plugin, paste the payload, click **Publish**.
4. It builds a "Components" page + one "Workflow: …" page per workflow. If those
   pages already exist they are **archived (renamed)**, never deleted — confirm
   when prompted.
