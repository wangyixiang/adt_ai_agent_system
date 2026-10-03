---
name: Obsidian Telemetry
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#bfc7d2'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#89929b'
  outline-variant: '#3f4850'
  surface-tint: '#93ccff'
  primary: '#93ccff'
  on-primary: '#003351'
  primary-container: '#3198dc'
  on-primary-container: '#002c47'
  inverse-primary: '#006398'
  secondary: '#c0c1ff'
  on-secondary: '#1000a9'
  secondary-container: '#3131c0'
  on-secondary-container: '#b0b2ff'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#00a572'
  on-tertiary-container: '#00311f'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#cce5ff'
  primary-fixed-dim: '#93ccff'
  on-primary-fixed: '#001d31'
  on-primary-fixed-variant: '#004b73'
  secondary-fixed: '#e1e0ff'
  secondary-fixed-dim: '#c0c1ff'
  on-secondary-fixed: '#07006c'
  on-secondary-fixed-variant: '#2f2ebe'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  code-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.06em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.75rem
  margin: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

This design system targets systems engineers, site reliability specialists, and autonomous agent operators running heavy diagnostic operations within a native desktop container. The aesthetic is engineered for cognitive clarity under incident pressure: surgical, structured, calm, and unmistakably technical. 

Drawing from modern technical minimalism, precision telemetry instrumentation, and developer tool utility, the interface prioritizes dense telemetry readouts without visual exhaustion. Key mechanical elements include:
- Crisp 1px structural boundary lines separating processing partitions.
- Explicit visual isolation for deterministic machine actions versus non-deterministic agent heuristics.
- High-efficiency screen utilization optimized for widescreen desktop and multi-monitor operations.
- Minimalist tactile micro-interactions that communicate state execution, process runs, and stream outputs immediately.

## Colors

The palette is anchored on deep, cold slate tones to reduce ocular fatigue over extended incident review windows, complemented by high-luminance semantic status indicators.

- **Primary (`#0284c7` - Sky 600 / Bright Cyan-Blue):** Represents live operational cycles, active execution traces, pending I/O streams, and active diagnostic probes.
- **Secondary (`#6366f1` - Indigo 500 / Purple-Indigo):** Identifies agent heuristics, cognitive loop states, model inference blocks, tool metadata, and vector memory retrieval.
- **Tertiary (`#10b981` - Emerald 500):** Communicates clean execution, validated assertions, passing diagnostic probes, and stable system health.
- **Neutral (`#0f172a` - Slate 900):** Forms the foundational background and surface ecosystem. Extended across deep values (`#020617` canvas base, `#0b0f19` recessed console zones, `#1e293b` borders, and `#334155` muted dividers).
- **Semantic Accents:**
  - **Warning / Degraded (`#f59e0b` - Amber 500):** Transient interruptions, rate-limiting, cancellation sequences, and manual intervention gates.
  - **Critical / Failure (`#f43f5e` - Rose 500):** Assertion failures, crashed thread loops, rejected payloads, and panic traces.

## Typography

Typography establishes an absolute separation between narrative system states and deterministic machine data.

- **Primary Interface (Inter):** Applied across global chrome, window control headers, navigation tabs, configuration summaries, and conversational agent syntheses. Inter's neutral glyph structure maintains legibility in high-density multi-column diagnostic views.
- **Data & Telemetry Engine (JetBrains Mono):** Mandated for runtime identifiers, cryptographic hashes, memory addresses, telemetry log lines, raw stack traces, API endpoints, tool payloads, and status chip labels. 
- **Type Scale Rules:** Headers do not scale aggressively, topping out at 24px desktop scale to preserve screen real estate for live execution panes.

## Layout & Spacing

The layout is built for Electron desktop environments utilizing a high-density, multi-pane fluid workspace model based on a fixed 4px spatial rhythm.

- **Viewport Partitioning:** The application relies on horizontal flex splits (collapsible diagnostic tree, active session timeline, inspection panel, and terminal drawer) with resizable splitter bars.
- **Vertical Rhythm:** Row heights for logs, telemetry events, and capability registries use compact 28px or 32px constraints. Padding inside data cells remains locked to `space-xs` (vertical) and `space-sm` (horizontal).
- **Responsive Adaptations:** 
  - Standard desktop scale (>1440px): 3-column triage layout (Agent Graph, Active Stream, Evidence Inspector).
  - Compact window scale (<1200px): Inspector transforms into a right-docked overlay drawer; secondary diagnostic columns collapse into segmented toggle tabs.

## Elevation & Depth

Visual hierarchy uses a disciplined **tonal surface layering system** paired with subtle, low-contrast 1px outlines rather than heavy atmospheric drop shadows.

- **Level 0 (Canvas Base):** `#020617` (Deep Slate Black) used for structural margins, window titlebars, and inactive track backgrounds.
- **Level 1 (Panels & Master Views):** `#0b0f19` bounded by 1px borders of `rgba(255, 255, 255, 0.08)`.
- **Level 2 (Cards & Evidence Modules):** `#131c2e` with inset hair-line highlights (`rgba(255, 255, 255, 0.05)`) along top borders to mimic machined bevels.
- **Level 3 (Dropdowns, Overlays, Floating Tooltips):** `#1e293b` with a sharp technical shadow: `0 4px 12px -2px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12)`.
- **Active Execution Focus:** Elements running dynamic agent analysis emit a targeted 1px outer glow using `rgba(2, 132, 199, 0.35)` to signal compute activity without shifting layouts.

## Shapes

The design uses tight, controlled geometric contours (`roundedness: 1` / `0.25rem` base radius) conveying precision and mechanical efficiency.

- **Controls, Cards, & Panels:** Standardized on `0.25rem` (4px). Matches the monospace character grid and prevents dead space inside dense data matrices.
- **Inspectors & Drawers:** `0.375rem` (6px) on primary window surfaces.
- **Status Indicators & Micro-Chips:** `0.25rem` (4px) with crisp border bounds; fully rounded pill shapes are strictly prohibited to avoid playful, non-technical visual metaphors.

## Components

### Buttons & Action Triggers
- **Primary Execution:** Solid background (`#0284c7`), high-contrast white text, `0.25rem` radius, 28px height, monospace tracking (`label-caps`). Active states feature a 1px inner border.
- **Secondary / Utility:** Surface `#1e293b`, text `#cbd5e1`, 1px border `#334155`. Transitions to background `#334155` on hover.
- **Agent Capability Triggers:** Dark tinted indigo surface (`rgba(99, 102, 241, 0.15)`), border `rgba(99, 102, 241, 0.4)`, text `#a5b4fc`.

### Diagnostic Chips & Status Badges
- Built with monospace uppercase typography (`label-caps`). Height fixed at 20px with inline SVG status glyphs (e.g., rotating spinner, cross, check, pause).
- **RUNNING / PENDING:** Background `rgba(2, 132, 199, 0.15)`, text `#38bdf8`, border `rgba(56, 189, 248, 0.3)`.
- **COMPLETED:** Background `rgba(16, 185, 129, 0.15)`, text `#34d399`, border `rgba(52, 211, 153, 0.3)`.
- **FAILED / REJECTED:** Background `rgba(244, 63, 94, 0.15)`, text `#fb7185`, border `rgba(251, 113, 133, 0.3)`.
- **WAITING / CANCELLING:** Background `rgba(245, 158, 11, 0.15)`, text `#fbbf24`, border `rgba(251, 191, 36, 0.3)`.

### Cards & Evidence Containers
- Base background `#0f172a`, border 1px solid `rgba(255, 255, 255, 0.08)`.
- Divided into structured sub-regions: header bar (action trigger, timestamp, payload digest), body (code/telemetry viewer), and expandable footer (raw JSON artifact attachment).
- Pinned attachments render as recessed `#020617` code blocks with inline copy-to-clipboard targets.

### Input Fields & Query Consoles
- Dark recessed fill (`#020617`), border 1px solid `#334155`, focus ring 1px solid `#0284c7`.
- Inputs use `code-md` for syntax-validated queries and parameter adjustments.

### Timeline & Diagnostic Tracing
- Vertical linear track (`#1e293b`, 1px width) connecting sequential step nodes.
- Nodes alternate states: completed steps convert to subtle solid dots; active steps pulse with cyan halos; failed steps lock with a rose diamond terminal node.