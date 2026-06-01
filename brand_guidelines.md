# Brand Guidelines

## Purpose

This document defines the visual, verbal, and interaction system for `my-clip-factory`.
It is based on a review of the current product UI and is intended to stop design drift across pages, cards, forms, and flows.

The product should feel like a local-first clip operations studio:

- sharp, editorial, and intentional
- technical without feeling developer-only
- high-signal, low-noise
- cinematic, but never decorative for its own sake

---

## Current Diagnosis

The current UI already has the beginnings of a strong brand, but it is not operating as a single system yet.

### What is working

- The dark atmospheric palette is distinct and appropriate for media tooling.
- The `Space Grotesk` + `JetBrains Mono` pairing is strong and gives the product a modern editorial-ops feel.
- Glassy panels, rounded cards, mono pills, and teal/amber accents create a recognizable base language.
- Transcript and clip-review surfaces are more intentional than generic CRUD UI.

### What is not working

- There are effectively two UI systems in the repo: a lean page-based flow and a richer dashboard/detail flow.
- Terminology changes between screens: `run`, `source`, `capture`, `clip`, `render`, and `template` are not used consistently.
- Equivalent actions use different labels and different component treatments.
- Status colors do not map cleanly to meaning.
- Form controls are inconsistent, especially `select`, `file`, and `color` inputs.
- Templates visually read too much like runs instead of a separate configuration object.
- Some interactions are hidden or improvised instead of designed.

---

## Brand Positioning

### Product Character

`my-clip-factory` is not a generic dashboard.
It is a live media control room for finding and shipping moments quickly.

The interface should communicate:

- active monitoring
- fast review
- precise control
- production readiness

### Tone

The tone should be:

- direct
- concise
- operational
- calm under pressure

Avoid:

- playful startup copy
- hyper-marketing language
- vague AI hype
- consumer social-app slang

---

## Core Design Principles

### 1. One Product, One Interface

All screens must feel like views into the same system.
If two pages perform the same job, they should use the same terminology, same component family, and same action hierarchy.

### 2. Signal First

Every surface should answer:

- What is happening now?
- What needs my attention?
- What can I do next?

Decorative UI should never compete with operational information.

### 3. Editorial Precision

Type, spacing, cards, and controls should feel composed, not improvised.
This is a media product, so the interface should have a sense of pacing and rhythm.

### 4. Distinct Object Types

Runs, clips, exports, templates, transcript tokens, and system alerts are not the same object.
They should not all look like the same card with different text.

### 5. Explicit Interaction

Important actions should be visible and legible.
Do not hide meaningful actions behind double-click, ambiguous pills, or ad hoc hover-only behavior.

---

## Visual Identity

### Overall Mood

The product should feel like a midnight edit suite:

- deep blue-black base
- cold glass surfaces
- mint/teal for active and successful states
- amber for in-progress and review states
- coral/red for failure and destructive actions

### Color Roles

Use color semantically, not decoratively.

- `Teal`: active capture, successful render, selected positive control, confirmed state
- `Amber`: pending review, queued work, in-progress state, cautionary attention
- `Red/Coral`: error, failed render, destructive action, blocked state
- `Muted blue-gray`: metadata, timestamps, helper text, tertiary information

### Status Mapping

Statuses should map consistently across pills, strips, cards, and tables:

- `active`: teal
- `rendered` or `ready`: teal
- `pending`: amber
- `approved`: neutral-teal or muted confirmed tone, not the same as `pending`
- `rendering` or `queued`: amber
- `rejected`: red-muted
- `error`: red
- `stopped`: neutral-muted

Do not use the same color for `approved`, `pending`, and `rendering`.

---

## Typography

### Primary Typeface

Use `Space Grotesk` for:

- page titles
- section titles
- card titles
- primary body copy

### Secondary Typeface

Use `JetBrains Mono` for:

- timestamps
- pills
- labels with operational meaning
- file names
- small technical metadata

### Type Rules

- Hero and page titles should feel compact, high-contrast, and editorial.
- Body copy should be concise and slightly restrained.
- Uppercase mono labels should be reserved for metadata and control language, not full paragraphs.
- Avoid mixing too many text tones inside a single card.

### Naming Rules

Use one vocabulary set and stick to it:

- `Run`: the captured source session
- `Clip`: a proposed clip moment
- `Export`: a rendered video output
- `Template`: a reusable visual configuration
- `Capture`: the source ingestion process
- `Render`: the export generation process

Prefer:

- `Start Run`
- `Stop Run`
- `Approve Clip`
- `Retry Render`
- `Create Template`

Avoid switching between:

- `source` / `run`
- `capture` / `clipping`
- `render timestamps` / `manual clip` / `approve timestamps`

---

## Layout System

### Page Structure

Each page should follow the same vertical rhythm:

1. Navigation / breadcrumb row
2. Page title + short supporting line
3. Primary action zone
4. Main operational content
5. Secondary configuration or historical content

### Surface Hierarchy

Use a clear three-level hierarchy:

- `Hero / header surface`: strongest visual treatment, for page framing and primary actions
- `Primary panel`: operational content, always readable first
- `Secondary panel / soft panel`: supporting configuration or drill-down content

### Spacing

Use spacing to communicate hierarchy:

- larger top-level gaps between sections
- medium gaps between cards
- tight internal spacing for metadata

Do not rely on arbitrary inline margins to solve composition problems.

---

## Component Guidelines

### Cards

Each object type needs a distinct card identity:

- `Run card`: source health, capture progress, last activity, next actions
- `Clip card`: clip framing, confidence, approval controls, transcript access
- `Export card`: preview, format, playback, output actions
- `Template card`: caption behavior, layout, audio behavior, asset attachments

Templates should not reuse `run-card` styling directly.
They need their own visual identity, likely cleaner and more configurational.

### Pills and Badges

Pills should be used for:

- status
- format
- timestamps
- compact metadata

Pills should not silently become primary interactive controls unless they are styled and announced as buttons.

### Buttons

There should be a clear action hierarchy:

- `Primary`: create, approve, render, save
- `Secondary`: refresh, cancel, view details
- `Danger`: stop, delete, reject

The same action should not move between button styles depending on screen.

### Alerts and Empty States

Use distinct containers for:

- system warning
- blocking error
- empty state
- helper note

Do not make all of these look like a minor footer note.

---

## Form Controls

This is the weakest part of the current system and needs standardization.

### Principle

Text inputs, selects, color inputs, file inputs, sliders, and chips should feel like part of one designed family, not browser defaults with shared padding.

### Selects

Current issue:

- native browser selects clash with the glass-panel aesthetic
- the default arrow/chrome does not match the rest of the product
- approval modal and templates page both expose this problem clearly

Directive:

- do not style `select` with the generic text-input class alone
- create a dedicated select component style
- use `appearance: none`
- apply custom chevron treatment
- increase right padding to account for the chevron
- match border, radius, background, focus ring, and hover behavior to text inputs
- use the same height as primary inputs

Selects should feel crisp, intentional, and slightly technical, not generic form controls.

### File Inputs

Native file inputs should not be presented as plain text fields.

Directive:

- replace raw file input presentation with a custom shell
- show selected file name in a secondary line
- pair with an explicit `Upload` or `Replace` affordance when needed
- make attachments feel like media assets, not plain form values

### Color Inputs

Native color pickers should not be dropped into a text field frame.

Directive:

- pair the swatch with the hex value
- present color as a compact branded control
- make it feel like a design-setting input, not a default browser widget

### Toggle Chips

Chip toggles are directionally correct, but they need a stronger system:

- use consistent sizing
- add hover and focus states
- distinguish selected state more clearly
- avoid using the same chip style for unrelated intents

---

## Interaction Guidelines

### Editing

Do not rely on double-click as a primary editing affordance.

If something is editable:

- show an edit icon or explicit `Edit` action
- reveal inline editing intentionally
- keep keyboard interactions obvious

### Disclosure

If a run card expands:

- the toggle should look like a disclosure control
- the card title should not masquerade as a nav link in one place and an expander in another

### Error Details

Error details should not be hidden inside a pill unless the pill is clearly a button.
Prefer:

- an icon button with `Details`
- a dedicated inline alert region
- a proper expandable error block

### Modal Behavior

Modals should be reserved for:

- focused transcript review
- approval confirmation/configuration

Modal content should not introduce a completely different control language from the rest of the app.

---

## Content Strategy

### Page Copy

All pages should describe the same product reality.
The product currently oscillates between:

- live-only clipping tool
- livestream and uploaded-video tool
- transcript dashboard
- render queue manager

Choose one clear framing and make all page copy align to it.

Recommended framing:

`A local-first clip operations studio for live and recorded video sources.`

### Microcopy Style

Use short, operational labels:

- `Start Run`
- `Refresh`
- `Approve`
- `Retry Render`
- `Rendered`
- `Queued`
- `Last Segment`
- `Last Analysis`

Avoid over-explaining on buttons.

### Empty States

Empty states should:

- explain what appears here
- explain what triggers it
- never sound generic

Good empty-state structure:

- what this section is for
- what needs to happen next

---

## Responsive Rules

The mobile behavior is serviceable, but the system needs stronger intent.

### Mobile Priorities

- preserve card hierarchy
- keep primary actions visible without crowding
- avoid horizontal compression of metadata
- maintain readable timestamp and pill layouts
- prevent modals from becoming dense control stacks

### Desktop Priorities

- preserve strong page framing
- use width intentionally
- avoid turning wide surfaces into generic two-column dashboards

---

## Do / Do Not

### Do

- keep the nocturnal editorial-ops mood
- use typography to create hierarchy
- make controls feel purpose-built
- distinguish object types clearly
- make state color meaningful
- unify labels and action names across all screens

### Do Not

- reuse one card style for every object in the product
- let pills silently become buttons
- hide key editing behind double-click
- mix live-only and recorded-video positioning casually
- use browser-default selects inside polished modals and panels
- rely on inline style patches instead of system-level tokens

---

## Immediate Design Priorities

These should be addressed first if the UI is being cleaned up:

1. Collapse to one canonical core experience for home/runs/run detail.
2. Standardize vocabulary across all pages and actions.
3. Introduce a proper form-control system, starting with selects.
4. Separate run, clip, export, and template card systems.
5. Redefine status color mapping so meaning is consistent everywhere.
6. Replace hidden interactions with explicit controls.

---

## Definition of Done for Future UI Work

A new UI change is not complete unless:

- it uses the canonical vocabulary
- it uses the shared color and status logic
- it fits the same control family as the rest of the product
- it preserves the dark editorial-ops mood
- it does not introduce a second visual language
- it works on desktop and mobile without collapsing hierarchy
