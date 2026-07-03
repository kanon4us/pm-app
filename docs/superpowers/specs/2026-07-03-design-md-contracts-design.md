# DESIGN.md Contracts — Design

**Date:** 2026-07-03
**Status:** Approved by PM ("build DESIGN.md first", ahead of the Figma MCP OAuth work)

## Goal

Stop re-deriving each app's design language on every prototype run. Encode it once per app in Google's open-source **DESIGN.md** format (github.com/google-labs-code/design.md — YAML tokens + prose rationale + Agent Prompt Guide) and inject it into the prototyping system prompt.

## Design

- **Files:** `design/DESIGN-<appSlug>.md` in pm-app — one per `APP_REGISTRY` slug. Lives in pm-app (not the product repos) per the read-only-product-repo rule and the "in pm-app, about the product" convention. v1 ships `DESIGN-web.md` only; other apps get contracts when their design language is researched.
- **Content source (web):** researched from code truth — `pages/_app.tsx` antd-style theme (`colorPrimary #00aaff`, Montserrat via next/font), `styles/globals.scss` (radius ~10px, card shadow, weights), component conventions (antd 5 idiom, wrappers), product screenshots. Neutral palette values are best-effort pending the Foundations — WEB Tokens page; the file is a living contract.
- **Loader:** `lib/claude/design-md.ts` — `getDesignContract(slug)`: sync fs read from `design/`, module-level cache, `null` when missing (prompt omits the block). `next.config.ts` gains `outputFileTracingIncludes` so Vercel bundles the .md files with the message-route function.
- **Injection:** `buildSystem()` appends a `--- DESIGN CONTRACT (<app label>) ---` block after `PROTOTYPING_SYSTEM` when the phase is prototyping. Static content → prompt-cache friendly.
- **Prompt rewire:** the research section now says: contract = styling source of truth; repo/Figma research focuses on the FEATURE (layout, components, states); `get_figma_styles` remains for values the contract lacks.
- **Lint:** `npm run design:lint` wraps `npx @google/design.md lint` (validated clean: 0 errors — note the spec only allows px/rem/em token units, so avatar `50%` rounding lives in prose).

## Testing

`tsc` + `next build`; live: render a web prototype and verify Montserrat + `#00aaff` + tinted `#f2f7fc` canvas appear without the model calling `get_figma_styles`/reading theme files first.

## Out of scope

CMS/mobile/desktop contracts (need research sessions per app); CI lint gate; auto-regenerating the contract from the Foundations Tokens page; DESIGN.md export for the Figma agent side.
