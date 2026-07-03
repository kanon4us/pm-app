---
name: Viscap Web App
colors:
  primary: "#00aaff"
  primary-hover: "#0095e0"
  ink: "#1f2733"
  secondary-text: "#6c7278"
  border: "#e4e8ee"
  surface: "#ffffff"
  background: "#f2f7fc"
  background-tint: "#eaf4fd"
  success: "#52c41a"
  warning: "#faad14"
  danger: "#ff4d4f"
typography:
  h1:
    fontFamily: Montserrat
    fontSize: 2.5em
    fontWeight: 700
  h2:
    fontFamily: Montserrat
    fontSize: 1.75em
    fontWeight: 700
  h3:
    fontFamily: Montserrat
    fontSize: 20px
    fontWeight: 500
  body:
    fontFamily: Montserrat
    fontSize: 14px
    fontWeight: 500
  label:
    fontFamily: Montserrat
    fontSize: 12px
    fontWeight: 500
rounded:
  sm: 6px
  md: 10px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
shadow:
  card: "-2px 3px 11px rgba(0, 0, 0, 0.3)"
---

## Overview

Clean, airy SaaS admin — a light blue-tinted workspace where white cards float
on a pale canvas and one saturated blue does all the interactive talking. The
feel is friendly-professional: rounded corners everywhere, generous white
space, medium-weight Montserrat, never cramped or gray-on-gray. Dark mode
exists (antd-style appearance toggle) but light is the primary design target.

## Colors

- **Primary (#00aaff):** The single interaction color — buttons, active tab
  underlines, selected states, links, toggles, focus rings. Never used for
  large surface fills; it reads as an accent against the pale canvas.
- **Ink (#1f2733):** Headings and primary text. Near-black with a cool cast,
  not pure #000.
- **Secondary text (#6c7278):** Metadata, captions, placeholder text, inactive
  tab labels.
- **Background (#f2f7fc) / tint (#eaf4fd):** The page canvas is a pale
  blue-tinted off-white — NOT pure white and NOT neutral gray. Sidebars and
  panels may use the slightly deeper tint.
- **Surface (#ffffff):** Cards, modals, drawers, and inputs sit on pure white
  above the tinted canvas, separated by the light border (#e4e8ee) more often
  than by shadow.
- **Status colors** follow Ant Design defaults: success #52c41a, warning
  #faad14, danger #ff4d4f. Use them only for status, never decoration.

## Typography

Everything is **Montserrat** (loaded via next/font; fallback sans-serif).
Default body weight is 500 — the product's text reads slightly bolder than a
typical 400-weight app; respect that. Headings step up to 700. Small labels
and chips run 12px. Never introduce a second typeface.

## Shape & Depth

- Cards, inputs, buttons, and modals round at ~10px (`md`); chips and filter
  pills are fully rounded (`pill`); avatars are full circles (border-radius
  50% — expressed in prose because the spec's token units are px/rem/em only).
- Depth is used sparingly: most separation comes from the tinted-canvas /
  white-card contrast and 1px #e4e8ee borders. The heavy card shadow
  (`shadow.card`) is reserved for floating elements — popovers, drag states,
  session cards.

## Components

The product is **Ant Design 5** themed via `antd-style` (`colorPrimary:
#00aaff`, `fontFamily: Montserrat`), with thin local wrappers
(`AntdTable`, `AntdTypography`, `ColoredTag`, `EditableTag`, `OrangeButton`).
Prototype the antd idiom: antd-shaped tables (light header row, hover
highlight), tag/chip metadata pills with light borders, Segmented-style
toggles for view switches, Drawer-style side panels (~600px, slide from
right) for detail views, tabbed detail layouts with a blue active-tab
underline. Search inputs are rounded with a leading magnifier icon.

## Agent Prompt Guide

- Treat the tokens above as authoritative — do not invent hex values, fonts,
  or radii. If a needed token is missing here, match the nearest existing one
  and note the gap in your reply.
- Import Montserrat (weights 500/600/700) via Google Fonts in prototypes.
- Compose screens as: tinted canvas → white cards/panels → #00aaff accents.
  A prototype whose page background is pure white or neutral gray is
  off-brand.
- Detail views open as right-side panels/drawers over the list they came
  from, not as separate pages.
- Populate every region the design shows populated (grids get 8–12 varied
  mock items with photos via picsum.photos).
- This file describes the WEB app only. It complements — never replaces —
  feature-specific Figma frames: view them for layout truth, use these tokens
  for styling truth.
