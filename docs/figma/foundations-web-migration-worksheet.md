# Foundations — WEB: Migration Worksheet

**Date:** 2026-07-03
**Goal:** Split the generic `⬡ FOUNDATIONS / Components` file (key `L2WtMQ5D7np7KDJ2vm3Ly0`) into a per-app **`Foundations — WEB`** file anchored to `Viscap-Media/app.viscap.ai`, published as a team library that all `▣ WEB APP` domain files consume as instances.

**Source-of-truth chain:** domain file → (library instance) `Foundations — WEB` component → `codePaths:` → actual code file → (code wraps) Ant Design.
The Figma layer mirrors this exactly: domain files instance foundation components; foundation components may derive from the **Ant Design System 5.11** vendor kit — legitimate here because the code itself wraps antd (`utils/AntdTable.tsx`, `AntdTypography.tsx`, `AntdFormLabel.tsx`, `WithThemeTokens.tsx`).

## Step 0 — Create the file

- New file in `⬡ FOUNDATIONS`: **`Foundations — WEB`**
- File description: `codePaths: Viscap-Media/app.viscap.ai@develop — shared components under components/Admin/{AdminHeader,AdminNav,CommonSelect,Comments,PageCommonHeader,modals,utils} + components/shared + components/AdminContainer`
- Publish as team library once pages below exist. Domain files in `▣ WEB APP` then enable ONLY this library (+ nothing directly from the Ant kit).

## Step 1 — Migrate existing Components-file content

### Page `Navbar` (35 nodes) → foundation pages `AdminNav` + `AdminHeader`

| Figma node | → Page | Code anchor |
|---|---|---|
| `Navbar` COMPONENT_SET + Navbar frames | AdminNav | `components/Admin/AdminNav/AdminNav.tsx` |
| `Menu Item / Actor Hub · Ideation · Settings · Media Library · Creatives · Mission Control` sets | AdminNav | `components/Admin/AdminNav/NavPathItem.tsx` (rename frames to `NavPathItem / <section>`) |
| `Notification`, `Notifications`, `Menu Item / Notifications` sets | AdminHeader | `components/Admin/AdminHeader/TeamNotifications.tsx` |
| `Team Menu / *Dropdown Menu*` frames | AdminHeader | `components/Admin/AdminHeader/AdminHeader.tsx` |
| `UI.Heading`, `*Dropdown Menu*`, `*Layout*` instances | — | External-library instances (vendor kit). Keep as instances inside the components above; do not migrate as standalone items. |
| `Frame 1321314773`, `image 1` rectangle | Archive | No code anchor — junk/reference. |

### Page `Insufficient permissions / plan` (14 nodes) → foundation page `Modals`

| Figma node | Code anchor |
|---|---|
| `*Modal* / With Overlay` instances/frames | `components/Admin/modals/OutOfTokensModal.tsx` (plan/permissions context) — verify content; rename frames to the modal they depict |
| `*Modal* / Confirmation` | `components/Admin/modals/ConfirmModal.tsx` |
| `*Notification*` instance | `components/Admin/AdminHeader/TeamNotifications.tsx` or antd notification wrapper — decide on sight |
| `UI.Heading` instances | vendor-kit instances inside the modals — keep nested |

### Pages `Multi-Select` and `---` (both EMPTY)

Delete, or keep `Multi-Select` as the seed of the `Selects & Inputs` page (Step 2.3).

### Pages `Cover`, `Archive`

Migrate as-is (`Cover` refreshed with the new file name; `Archive` stays the in-file graveyard).

## Step 2 — Create the missing pages (code exists, Figma doesn't)

1. **`Tokens`** — from the antd theme configuration (`components/Admin/utils/WithThemeTokens.tsx` is the code anchor; NOTE: there is no tailwind.config in this repo — the product's styling is antd theme + CSS modules). Colors, typography scale, radii, shadows as styles/variables. This page is what `get_figma_styles` should be pointed at for exact tokens.
2. **`Comments`** — completely missing in Figma; code has a full family: `Comment.tsx`, `CommentFooter.tsx`, `CommentInput.tsx`, `CommentReplies.tsx`, `InternalDiscussion.tsx`, `StoryboardComments.tsx`. One component per code file, names matching.
3. **`Selects & Inputs`** — `CommonSelect/index.tsx`, `utils/ActorSelect`, `utils/FilterSettings.tsx`, `utils/FormikComponents`, `utils/loadingSelectOption.tsx`.
4. **`Page chrome`** — `PageCommonHeader/index.tsx`, `utils/PageHeaderBar.tsx` + `PageHeaderBarNew.tsx` (flag: TWO header bars in code — ask eng which is canonical before drawing both), `utils/PageWrapper.tsx`, `AdminContainer`.
5. **`Primitives`** — `utils/ColoredTag`, `EditableTag.tsx`, `ElementTypeTagV2`, `Avatar.ts`, `CroppedImage`, `OrangeButton.tsx`, `Spinner.tsx`, `VideoPlayIcon`, `UploadPopovers`, `UploadWithNameEllipsis`, `StorageLimitPopover.tsx`, `DrawerHelp.tsx`; plus `components/shared/Logo`. Most are thin antd wrappers — instance from the vendor kit and restyle, matching what the code does.
6. **`Modals`** (extends Step 1) — remaining code modals with no Figma presence: `AddToShotlistModal`, `ClipContextModal`, `CreatePhaseModal`, `EditAssigneesModal`, `LoadingClipsModal`, `MarkAllAsReadModal`, `MobileModal`, `NotificationSettingsModal`, `RenameClipsModal`, `ShotlistFormModal`. Draw on demand (when a feature touches them), not up front — but list them on the page as placeholders so gaps are visible.

## Step 3 — Rules going forward

- Frame/component name = code file name (`TalentDetails`, `NavPathItem`), variants via Figma variant props.
- Every foundation page carries its `codePaths:` line in the page description.
- Domain files never redraw shared elements — if the same element appears in two domain files, it moves here and both take instances.
- Vendor kit (`Ant Design System 5.11`) is consumed ONLY by this file, mirroring how only wrapper components import antd in code.
- Mirror at milestones, not per iteration. `Components` file: archive after migration (rename `▢ Components (migrated → Foundations — WEB)`).

## Decisions — LOCKED (Michael, 2026-07-03)

1. **Page headers: keep BOTH.** `PageHeaderBar` and `PageHeaderBarNew` are each canonical for a different target user group / permission tier. Draw both on the `Page chrome` page; each frame's description states its audience so nobody "consolidates" them by accident.
2. **Empty pages: purge.** `Multi-Select` and `---` are deleted, not repurposed — the index stays restricted to active code coverage. The Selects & Inputs page is created fresh when that family gets drawn.
3. **Pre-App / Funnel Context: new top-level Figma project** (sibling of `▣ WEB APP` / `⬡ FOUNDATIONS`). Holds (a) Webflow page blueprints — static representations of marketing/intake pages that live upstream of the React app — and (b) the team-provisioning flow (what happens before a user reaches the dashboard). This keeps the React-anchored foundation 100% clean while giving prototyping Claude the user-state context. Nuance: `components/MembershipOffer` is React code, so its *component* lives in `Foundations — WEB` (Primitives); its *usage context* is documented in Pre-App / Funnel Context.
4. **Per-app repo anchors (verified against the GitHub org):**
   - CMS → `codePaths: Viscap-Media/education-cms@develop`
   - Mobile → `codePaths: Viscap-Media/media-sync-mobile@main` ⚠️ default branch is `main`, not `develop`
   - NEW FINDING: the org also has **`media-sync-desktop`** — a fourth app not in the web/cms/mobile plan. Decide whether it gets its own foundation or shares Mobile's.

## Execution roadmap (agreed)

1. **Lock the blueprint** — this file, updated with the decisions above, merges via PR #25.
2. **Workspace + tokens** — create `Foundations — WEB`, extract design tokens from the antd theme (`WithThemeTokens.tsx`) into the Tokens page.
3. **Structural porting (~1h)** — Navbar page → `AdminNav`/`AdminHeader`; modal page → `OutOfTokensModal`/`ConfirmModal`; placeholder markers for the missing families (Comments, Selects & Inputs, Page chrome, Primitives).
4. **Publish the library** — then the absolute rule applies: instance from the library, never draw from scratch.
5. **Pre-App / Funnel Context project** — created independently; no code anchors (Webflow is upstream of the repos).
6. **CMS / Mobile (/ Desktop?) foundations** — same worksheet exercise against their repos. Note for pm-app tooling: chat tools currently read a single `CODE_REPO` env; multi-app prototyping requires a per-feature repo mapping (features table or app column) before Claude can research education-cms or media-sync-mobile.
