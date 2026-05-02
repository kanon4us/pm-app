# Feature Prototype Builder — Design Spec

**Date:** 2026-05-02
**Status:** Approved for implementation

## Overview

A new feature planning surface attached to existing tasks. Product managers link one or more features to a task, define user stories and scenarios for each feature, attach Figma screen links per step, and collaborate with Claude to produce an HTML slideshow prototype. The prototype is stored in Supabase Storage (for permanent image assets) and pushed to the vault so developers, QA, customer success, and education teams can access it at any point in the feature lifecycle.

A key distinction: **features** represent the product intent (what the end user experiences), while **tasks** represent the work items in ClickUp that implement them. The relationship is many-to-many in both directions.

---

## Data Model

### New Tables

#### `features`
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| name | text | |
| description | text | |
| status | `'draft' \| 'active' \| 'archived'` | |
| created_at | timestamptz | |

#### `feature_tasks` (junction)
| Column | Type | Notes |
|---|---|---|
| feature_id | uuid → features | |
| task_id | uuid → tasks | |
| pk | (feature_id, task_id) | |

#### `user_stories`
Standalone entity — reusable across features.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| title | text | Short label |
| as_a | text | Role/persona |
| i_want | text | Goal |
| so_that | text | Benefit |
| created_at | timestamptz | |

#### `feature_user_stories` (junction)
| Column | Type | Notes |
|---|---|---|
| feature_id | uuid → features | |
| user_story_id | uuid → user_stories | |
| display_order | int | Order within this feature |
| pk | (feature_id, user_story_id) | |

#### `scenarios`
Owned by a user story. A scenario is one specific path through the story (happy path, error path, edge case, etc.).

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| user_story_id | uuid → user_stories | |
| title | text | |
| description | text | |
| display_order | int | Order within this story |

#### `steps`
Ordered steps within a scenario. Each step maps to one Figma screen provided by the designer.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| scenario_id | uuid → scenarios | |
| title | text | |
| description | text | Narration/annotation; Claude parses this for hotspot intent |
| figma_url | text | Designer-provided link |
| figma_frame_id | text | Parsed from URL, used for API calls |
| figma_thumbnail_url | text | Permanent Supabase Storage URL (set after first fetch+upload) |
| display_order | int | |

#### `feature_prototypes`
One record per generated prototype. Can be scoped to a single scenario or cover all scenarios for a feature.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| feature_id | uuid → features | |
| scenario_id | uuid → scenarios (nullable) | null = full-feature prototype |
| is_current | boolean | True for the latest generation of this feature+scenario combination |
| html_content | text | The complete self-contained HTML |
| vault_path | text | e.g. `prototypes/features/[feature-id]/[scenario-slug].html`; full-feature: `[feature-id]/all.html` |
| vault_url | text | GitHub URL after push |
| generated_by | text | User email |
| created_at | timestamptz | |

When a new prototype is generated for a feature+scenario combination, the previous record's `is_current` is set to false. Only the current prototype is surfaced in the UI; previous versions remain in Supabase as history.

#### `feature_conversations`
One active conversation per feature, lazy-created on first message. Persists across sessions — the same conversation continues indefinitely unless explicitly reset.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| feature_id | uuid → features (unique) | One per feature |
| status | `'in_progress' \| 'complete'` | |
| created_at | timestamptz | |

#### `feature_messages`
| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| conversation_id | uuid → feature_conversations | |
| role | `'assistant' \| 'user'` | |
| content | text | |
| created_at | timestamptz | |

### Relationship Summary

```
features  ←M:M→  tasks              (via feature_tasks)
features  ←M:M→  user_stories       (via feature_user_stories)
user_stories  →1:M→  scenarios  →1:M→  steps
features  →1:M→  feature_prototypes
features  →1:1→  feature_conversations  →1:M→  feature_messages
```

---

## UI Structure

### Surface A — Task Detail Panel: Features Tab

A new tab added to the existing task detail side panel alongside Assess, Bundle, and Checklist.

**Content:**
- List of features linked to this task, each showing name, story count, scenario count, and prototype status
- "Open Feature Editor" link on each card → navigates to the full-page editor
- "Link existing feature" action — searchable dropdown of existing features
- "New feature" action — inline name field that creates a feature and links it

### Surface B — Full-Page Feature Editor (`/features/[id]`)

Three-panel layout:

**Left panel — User Stories**
- Vertically stacked list of user stories linked to this feature
- Active story is highlighted; clicking switches the center panel context
- "Add story" opens an inline form (as_a / i_want / so_that fields)
- Stories can also be searched and linked from the global user story pool
- If a story is linked to more than one feature, an indicator shows how many features share it. Editing a shared story shows a warning: "This story is linked to N other features. Edits will affect all of them. Fork it to edit independently."

**Center panel — Scenarios & Steps**
- Shows scenarios for the active user story, each expandable
- Within each scenario, steps are displayed in order with:
  - Step number badge
  - Title + description (the description field is where PM writes narration and can use plain English like "Clicking Save goes to Step 4" to trigger hotspot generation)
  - Figma URL input (paste or type a valid Figma URL → thumbnail is fetched, uploaded to Supabase Storage, and displayed inline automatically)
  - Thumbnail preview with a "View in Figma" deep-link icon
  - Drag handle for reordering (display_order updated optimistically, persisted on drop)
- "Add step" adds a blank step row at the bottom
- "Add scenario" adds a new scenario tab
- **"Generate Prototype"** button — triggers prototype generation for the active scenario, producing one HTML file; a "Generate All" option runs generation for every scenario in the feature, producing one HTML file per scenario

**Right panel — Claude Chat**
- Persistent conversation scoped to the current feature
- Claude's context includes all user stories, scenarios, and steps in their current state (rebuilt on each message)
- Claude can: annotate steps, suggest missing steps, critique flows, generate the HTML prototype when asked
- **"Sync to Steps"** button appears on Claude messages that suggest a concrete step — clicking it adds that step to the active scenario without manual retyping
- **"App-wide Review"** button triggers a cross-feature UX review (see below)

### Surface C — App-wide Review Panel

Accessed via the "App-wide Review" button. A scoped, interactive findings panel:

- **Scope selector** — filter by feature status, linked task list, or name search. Defaults to all `active` features. Prevents token overflow as the product grows.
- Claude is called with the scoped feature set and returns structured findings
- Findings render as dismissible cards, each categorised as:
  - Overlapping flows (two features describe the same user journey)
  - Consolidation candidates (user stories that could be merged)
  - Missing edge cases (a scenario has no error/failure path)
  - Contradictions (same entry point, different outcomes across features)
- Each card links directly to the relevant feature editor
- "Export Summary" pushes a markdown summary of undismissed findings to the vault at `reviews/[date]-ux-review.md`

---

## Claude Conversation Design

### Per-Feature Context Block

Every message sent to Claude includes a system context block assembled from the current state of the feature:

```
Feature: [name]
Status: [status]

User Story 1: As a [as_a], I want [i_want] so that [so_that]
  Scenario A: [title]
    Step 1: [title] — [description] [image: [supabase-storage-url]]
    Step 2: [title] — [description] [image: [supabase-storage-url]]
  Scenario B: [title]
    ...

User Story 2: ...
```

Permanent Supabase Storage URLs are embedded directly so Claude can reference them in generated HTML without requiring any further fetches.

### Prototype Generation Prompt

When the user requests prototype generation (via chat or the Generate button), Claude receives the full feature context plus an explicit instruction to produce a self-contained HTML slideshow with:
- One slide per step
- Figma frame image (permanent Supabase Storage URL embedded as `<img src>`)
- "View in Figma" link per slide using the stored `figma_url`
- Step title and narration text
- Previous/Next navigation
- Scenario title and step counter in the header
- **Hotspot detection:** if a step description contains navigational language (e.g., "Clicking X goes to step 3", "Tapping Save proceeds to the confirmation screen"), Claude wraps the relevant element in a clickable `<button>` or `<a>` that jumps to the target slide. Claude infers intent from natural language — no coordinate UI required.
- No external dependencies (all CSS/JS inline)
- Dark-mode aware styling with a clean "Step X of Y" header overlay

### App-wide Review

Strictly UX/product-level — not a code analysis tool. The goal is to surface product design friction, not technical debt.

The scope selector in the UI constrains what features are sent. Claude returns structured JSON findings that the UI renders as actionable cards (see Surface C). Claude is instructed to focus on:
- User journeys that overlap across features
- User stories that could be consolidated without loss of specificity
- Scenarios that lack an error or edge-case path
- Contradictions between related features (same entry point, different outcomes)

---

## Prototype Generation Flow

1. User clicks "Generate Prototype" (active scenario) or "Generate All" (all scenarios in the feature)
2. **Image permanence pipeline** — for each step, silently in parallel:
   - If `steps.figma_thumbnail_url` is already a Supabase Storage URL → skip
   - Otherwise: fetch PNG from Figma API → upload to Supabase Storage at `prototype-assets/steps/[step-id].png` → write permanent URL back to `steps.figma_thumbnail_url`
3. API route (`/api/features/[id]/prototype`) calls Claude with full feature context (using permanent image URLs) and generation prompt
4. Claude returns the complete HTML string, with hotspots and "View in Figma" links embedded
5. Previous `is_current` prototype for this feature+scenario is flipped to false
6. HTML is saved to `feature_prototypes` with `is_current: true`
7. HTML is pushed to the vault at `prototypes/features/[feature-id]/[scenario-slug].html`; vault URL written back to the record
8. Features tab in the task panel reflects updated prototype status immediately

---

## API Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/features` | List all features (for linking) |
| POST | `/api/features` | Create a new feature |
| GET | `/api/features/[id]` | Full feature with stories/scenarios/steps |
| PATCH | `/api/features/[id]` | Update name/description/status |
| POST | `/api/features/[id]/tasks` | Link a task to a feature |
| DELETE | `/api/features/[id]/tasks/[taskId]` | Unlink a task |
| POST | `/api/features/[id]/stories` | Link or create a user story |
| DELETE | `/api/features/[id]/stories/[storyId]` | Unlink a user story from a feature |
| POST | `/api/features/[id]/prototype` | Trigger prototype generation |
| GET | `/api/features/[id]/conversation` | Get conversation history |
| POST | `/api/features/[id]/conversation/message` | Send a chat message |
| POST | `/api/features/review` | App-wide cross-feature UX review |
| POST | `/api/user-stories` | Create a standalone user story |
| PATCH | `/api/user-stories/[id]` | Update a user story |
| POST | `/api/user-stories/[id]/fork` | Fork a shared story into a feature-specific copy |
| POST | `/api/scenarios` | Create a scenario |
| PATCH | `/api/scenarios/[id]` | Update a scenario |
| POST | `/api/steps` | Create a step |
| PATCH | `/api/steps/[id]` | Update a step (including figma_url, triggers image upload) |
| DELETE | `/api/steps/[id]` | Remove a step |

---

## Out of Scope

- Writing to Figma (all Figma access is read-only via existing REST client)
- Creating Figma prototypes — the output is HTML, not a Figma prototype
- Live data in the HTML prototype — it is a static slideshow with optional navigational hotspots only
- The future "present a user story → brainstorm a feature" flow (schema is designed to support it; UI is not built here)
- Automatic prototype regeneration on step changes (user explicitly triggers generation)
- Presentation Mode / in-app chromeless iframe viewer (backlog — current GitHub vault URL is sufficient for demos)
