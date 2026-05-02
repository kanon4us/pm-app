# Feature Prototype Builder — Design Spec

**Date:** 2026-05-02
**Status:** Approved for implementation

## Overview

A new feature planning surface attached to existing tasks. Product managers link one or more features to a task, define user stories and scenarios for each feature, attach Figma screen links per step, and collaborate with Claude to produce an HTML slideshow prototype. The prototype is stored in Supabase and pushed to the vault so developers, QA, customer success, and education teams can access it at any point in the feature lifecycle.

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
| description | text | Narration/annotation for this step |
| figma_url | text | Designer-provided link |
| figma_frame_id | text | Parsed from URL, used for API calls |
| figma_thumbnail_url | text | Cached after first fetch |
| display_order | int | |

#### `feature_prototypes`
One record per generated prototype. Can be scoped to a single scenario or cover all scenarios for a feature.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| feature_id | uuid → features | |
| scenario_id | uuid → scenarios (nullable) | null = full-feature prototype |
| html_content | text | The complete self-contained HTML |
| vault_path | text | e.g. `prototypes/features/[feature-id]/[scenario-slug].html`; full-feature: `[feature-id]/all.html` |
| vault_url | text | GitHub URL after push |
| generated_by | text | User email |
| created_at | timestamptz | |

#### `feature_conversations`
One active conversation per feature, lazy-created on first message. Persists across sessions — the same conversation continues indefinitely unless explicitly reset.

| Column | Type | Notes |
|---|---|---|
| id | uuid pk | |
| feature_id | uuid → features (unique) | One per feature |
| status | `'in_progress' \| 'complete'` | |
| created_at | timestamptz | |

#### `feature_messages`
Mirrors `assessment_messages`.

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

**Center panel — Scenarios & Steps**
- Shows scenarios for the active user story, each expandable
- Within each scenario, steps are displayed in order with:
  - Step number badge
  - Title + description
  - Figma URL input (paste or type a valid Figma URL → thumbnail is fetched and cached automatically on input change when the URL is valid)
  - Thumbnail preview inline
  - Drag handle for reordering
- "Add step" adds a blank step row at the bottom
- "Add scenario" adds a new scenario tab
- **"Generate Prototype"** button — triggers prototype generation for the active scenario, producing one HTML file; a "Generate All" option runs generation for every scenario in the feature, producing one HTML file per scenario

**Right panel — Claude Chat**
- Persistent conversation scoped to the current feature
- Claude's context includes all user stories, scenarios, and steps in their current state (rebuilt on each message)
- Claude can: annotate steps, suggest missing steps, critique flows, generate the HTML prototype when asked
- **"App-wide Review"** button triggers a separate Claude call with all features in context, returning a structured report of overlaps, gaps, and consolidation opportunities

---

## Claude Conversation Design

### Per-Feature Context Block

Every message sent to Claude includes a system context block assembled from the current state of the feature:

```
Feature: [name]
Status: [status]

User Story 1: As a [as_a], I want [i_want] so that [so_that]
  Scenario A: [title]
    Step 1: [title] — [description] [thumbnail: cached/missing]
    Step 2: [title] — [description] [thumbnail: cached/missing]
  Scenario B: [title]
    ...

User Story 2: ...
```

Figma thumbnail URLs are included in the context so Claude can reference them when generating the prototype HTML.

### Prototype Generation Prompt

When the user requests prototype generation (via chat or the Generate button), Claude receives the full feature context plus an explicit instruction to produce a self-contained HTML slideshow with:
- One slide per step
- Figma thumbnail image displayed (via the cached URL)
- Step title and narration text
- Previous/Next navigation
- Scenario title and step counter in the header
- No external dependencies (all CSS/JS inline)

### App-wide Review

A separate API route (`/api/features/review`) fetches all features with their full user story/scenario/step trees and sends them to Claude in a single call. Claude returns a structured review covering:
- Flows that overlap across features
- User stories that could be consolidated
- Scenarios missing obvious edge cases
- Inconsistencies between related features

---

## Prototype Generation Flow

1. User clicks "Generate Prototype" (scoped to scenario) or "Generate All" (all scenarios)
2. For each step lacking a cached thumbnail, the existing `fetchFigmaFrames` client is called and the result is written back to `steps.figma_thumbnail_url`
3. API route (`/api/features/[id]/prototype`) calls Claude with the full feature context and generation prompt
4. Claude returns the complete HTML string
5. HTML is saved to `feature_prototypes` (Supabase) with `html_content`, `feature_id`, and `scenario_id`
6. HTML is pushed to the vault repo at `prototypes/features/[feature-id]/[scenario-slug].html` via the existing GitHub client; the resulting URL is written back to `feature_prototypes.vault_url`
7. The task detail Features tab reflects the updated prototype status immediately

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
| POST | `/api/features/review` | App-wide cross-feature review |
| POST | `/api/user-stories` | Create a standalone user story |
| PATCH | `/api/user-stories/[id]` | Update a user story |
| POST | `/api/scenarios` | Create a scenario |
| PATCH | `/api/scenarios/[id]` | Update a scenario |
| POST | `/api/steps` | Create a step |
| PATCH | `/api/steps/[id]` | Update a step (including figma_url) |
| DELETE | `/api/steps/[id]` | Remove a step |

---

## Out of Scope

- Writing to Figma (all Figma access is read-only via existing REST client)
- Creating Figma prototypes — the output is HTML, not a Figma prototype
- Live data in the HTML prototype — it is a static slideshow only
- The future "present a user story → brainstorm a feature" flow (schema is designed to support it; UI is not built here)
- Automatic prototype regeneration on step changes (user explicitly triggers generation)
