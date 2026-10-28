# Yumi — Design System & UX Specification (design.md)

**Companion to:** `PRD.md`, `appflow.md`
**Version:** 1.0 (tokens finalized from design references)
**Updated:** 2026-07-13

**Design references (provided by owner):**
- *Another Fashion Reference Website* — editorial, high-contrast, big type.
- *Marketing Agency Landing Page / Creative Studio* — bold, expressive, color-blocked.

**Locked direction:**
| Dimension | Decision |
|---|---|
| Aesthetic | **Bold creative studio** — oversized type, color blocking, marquee, asymmetric layout, high energy |
| Color base | **Warm light (cream / off-white)**, with a warm-dark counterpart |
| Accent | **Terracotta / rust** (`#C4622D` → `#B5482E`) |
| Typography | **Bold grotesque sans** for display + UI; monospace for code |

> **Core design tension (read this first):** Yumi's *marketing, dashboard, onboarding, and empty states* should be **loud and expressive** (this is where the creative-studio references live). The *live workspace* (editor, canvas, terminal, video) must be **calm, quiet, and low-noise** — dense real-time collaboration cannot fight for attention with big color blocks. **Expressive at the edges, calm in the cockpit.** Every component spec below notes which mode it belongs to.

---

## 1. Design Principles

1. **Expressive at the edges, calm in the cockpit.** Bold editorial personality on entry surfaces; restraint inside real-time work.
2. **One surface, no seams** — canvas, code, chat, video read as one workspace with a shared visual language.
3. **Real-time made visible** — every collaborator has one consistent color identity across cursor, selection, attribution, avatar, and activity feed.
4. **Progressive disclosure** — minimal default UI (students/general); power revealed on demand (developers).
5. **Desktop-first, mobile-respectful.**
6. **Accessible by default** — WCAG 2.1 AA in both themes.
7. **Theme-native** — warm light and warm dark are both first-class.

---

## 2. Color System

### 2.1 Neutrals & surfaces

**Light theme (default — warm cream):**
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#F4F1EA` | App background (warm cream) |
| `--bg-raised` | `#FBFAF7` | Cards, panels, raised surfaces |
| `--bg-sunken` | `#ECE7DC` | Wells, inputs, code gutter |
| `--bg-inverse` | `#1A1712` | Color-blocked sections (creative-studio blocks) |
| `--ink` | `#1A1A1A` | Primary text |
| `--ink-secondary` | `#55514A` | Secondary text (warm gray) |
| `--ink-muted` | `#8A857B` | Muted/meta text, placeholders |
| `--border` | `#DED8CB` | Hairline dividers, editorial rules |
| `--border-strong` | `#C7BFAE` | Emphasized borders, focus outlines base |

**Dark theme (warm charcoal — not pure black):**
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#17150F` | App background (warm near-black) |
| `--bg-raised` | `#221F18` | Cards, panels |
| `--bg-sunken` | `#100E0A` | Wells, inputs, gutter |
| `--bg-inverse` | `#F4F1EA` | Inverted color blocks |
| `--ink` | `#F4F1EA` | Primary text (cream) |
| `--ink-secondary` | `#B8B2A5` | Secondary |
| `--ink-muted` | `#857F72` | Muted/meta |
| `--border` | `#322E25` | Dividers |
| `--border-strong` | `#4A4437` | Emphasized borders |

### 2.2 Brand accent (terracotta / rust)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#C4622D` | `#E0784A` | Primary accent (large type, highlights, active) |
| `--accent-strong` | `#B5482E` | `#EC8A5C` | Buttons w/ small text, hover-press (AA for small text) |
| `--accent-soft` | `#F0DFD2` | `#3A2A1E` | Tinted backgrounds, selection wash, badges |
| `--accent-contrast` | `#FFFFFF` | `#17150F` | Text/icon on accent fill |

**Contrast rule:** the light `--accent` (`#C4622D`) meets AA-large (≥3:1) on cream but **not** AA for small body text — use it only for ≥24px/bold headings, icons, and rules. For buttons/chips with small labels use `--accent-strong` (`#B5482E`) with white text (≥4.5:1). A CI contrast validator (§9) enforces this.

### 2.3 Semantic

| Token | Light | Dark |
|---|---|---|
| `--success` | `#2E8B4F` | `#4FBE77` |
| `--warning` | `#D9902B` | `#E8A94F` |
| `--error` | `#C4362E` | `#E85C52` |
| `--info` | `#2B6CB0` | `#5A9BE0` |

> Note: `--warning` sits near the terracotta hue — never use warning color as a decorative accent; reserve it for genuine warnings to avoid semantic confusion with the brand.

### 2.4 Collaborator palette (identity colors)

A fixed set of **8 hues**, spread evenly around the wheel, **excluding the red-orange band** (reserved for the terracotta brand) so a user's cursor is never confused with brand UI. Each is mid-saturation/mid-lightness to read on **both** cream and warm-dark, and ordered for colorblind separability (blues/greens/violets/magentas alternate).

| # | Name | Hex | Label text |
|---|---|---|---|
| 1 | Gold | `#C79A1E` | `#1A1712` |
| 2 | Green | `#3C8C43` | `#FFFFFF` |
| 3 | Teal | `#0E8F82` | `#FFFFFF` |
| 4 | Sky | `#2E86C1` | `#FFFFFF` |
| 5 | Cobalt | `#2F5FE0` | `#FFFFFF` |
| 6 | Violet | `#7A4FE0` | `#FFFFFF` |
| 7 | Berry | `#9B3FA8` | `#FFFFFF` |
| 8 | Magenta | `#C6317E` | `#FFFFFF` |

**Rules:**
- Assigned stably per user (`users.avatarColor`) and used **everywhere** that user appears (cursor, selection tint at ~20% alpha, avatar ring, name label, attribution, activity entry).
- Label text color is pre-paired above for AA on the color chip.
- Beyond 8 concurrent users, cycle with a subtle pattern/index badge to disambiguate duplicates.
- Must be run through the §9 contrast/colorblind validator before shipping; adjust lightness per theme if a hue fails on dark.

### 2.5 CSS variable scaffold

```css
:root {                     /* light (default) */
  --bg:#F4F1EA; --bg-raised:#FBFAF7; --bg-sunken:#ECE7DC; --bg-inverse:#1A1712;
  --ink:#1A1A1A; --ink-secondary:#55514A; --ink-muted:#8A857B;
  --border:#DED8CB; --border-strong:#C7BFAE;
  --accent:#C4622D; --accent-strong:#B5482E; --accent-soft:#F0DFD2; --accent-contrast:#FFFFFF;
  --success:#2E8B4F; --warning:#D9902B; --error:#C4362E; --info:#2B6CB0;
}
:root[data-theme="dark"] {  /* warm dark */
  --bg:#17150F; --bg-raised:#221F18; --bg-sunken:#100E0A; --bg-inverse:#F4F1EA;
  --ink:#F4F1EA; --ink-secondary:#B8B2A5; --ink-muted:#857F72;
  --border:#322E25; --border-strong:#4A4437;
  --accent:#E0784A; --accent-strong:#EC8A5C; --accent-soft:#3A2A1E; --accent-contrast:#17150F;
  --success:#4FBE77; --warning:#E8A94F; --error:#E85C52; --info:#5A9BE0;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { /* mirror dark tokens */ } }
```
Theme toggle stamps `data-theme` on `:root`; system preference is the default when unset.

---

## 3. Typography

### 3.1 Families
| Role | Font | Fallback stack | Notes |
|---|---|---|---|
| Display / headings | **Space Grotesk** (700/800) | `"Archivo", "Helvetica Neue", Arial, sans-serif` | Bold grotesque — the creative-studio voice |
| UI / body | **Space Grotesk** (400–600) | `"Inter", system-ui, sans-serif` | Same family for cohesion; **Inter** is the pragmatic fallback for long-form/dense text legibility |
| Code / mono | **JetBrains Mono** | `"IBM Plex Mono", ui-monospace, monospace` | Editor + inline code + code blocks in chat |

> If a licensed "expressive display" face is later chosen (e.g. Clash Display) for hero-only marketing, scope it to marketing surfaces; keep Space Grotesk for product UI.

### 3.2 Type scale
Base 16px. Big jumps for the bold creative-studio feel; tighter tracking on large sizes, editorial uppercase micro-labels.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `display-xl` | 72 / 1.0 | 800 | Marketing/onboarding hero |
| `display-l` | 56 / 1.05 | 800 | Section heroes, big empty-state numerals |
| `h1` | 40 / 1.1 | 700 | Page titles |
| `h2` | 30 / 1.15 | 700 | Section headers |
| `h3` | 22 / 1.25 | 600 | Panel/card headers |
| `body-lg` | 18 / 1.5 | 400–500 | Intro copy |
| `body` | 15 / 1.55 | 400 | **UI default** |
| `small` | 13 / 1.45 | 400–500 | Secondary UI, captions |
| `meta` | 11 / 1.4, `+0.08em`, UPPERCASE | 600 | Editorial labels, tags, index numbers (`01 / 02`) |
| `code` | 13.5 / 1.6 | 400 | Editor/code |

**Editorial devices** (marketing/dashboard only): oversized index numerals (`01`, `02`), UPPERCASE tracked micro-labels, thin `--border` rules under headings, tight-tracked huge display type.

---

## 4. Spacing, Radius, Elevation, Motion

### 4.1 Spacing (4px base)
`--sp-1:4 · --sp-2:8 · --sp-3:12 · --sp-4:16 · --sp-5:24 · --sp-6:32 · --sp-7:48 · --sp-8:64 · --sp-9:96 · --sp-10:128`
- Workspace UI: dense (4–16). Marketing/empty states: generous (48–128) for editorial whitespace.

### 4.2 Radius (fairly sharp — editorial)
`--r-sm:4 · --r-md:8 · --r-lg:12 · --r-xl:20 · --r-pill:999`
- Controls: 8 · Cards/panels: 12 · Modals: 20 · Avatars/chips: pill. Color-blocked marketing sections may use `0` (hard edges) deliberately.

### 4.3 Elevation (warm-tinted shadows)
| Token | Light |
|---|---|
| `--e1` | `0 1px 2px rgba(26,22,15,.06)` |
| `--e2` | `0 4px 12px rgba(26,22,15,.08)` |
| `--e3` | `0 12px 32px rgba(26,22,15,.14)` |
Dark theme: reduce alpha, rely more on `--border` + `--bg-raised` separation.

### 4.4 Motion
| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover, toggles |
| `--dur-base` | 200ms | Panels, toasts |
| `--dur-slow` | 320ms | Modals, page transitions |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | Default |
| `--ease-out` | `cubic-bezier(0,0,.2,1)` | Entrances |
| marquee | `linear`, ~30s loop | Marketing/activity ticker |
- **Cursor smoothing:** interpolate remote cursors ~80–120ms so they glide, not teleport.
- **Respect `prefers-reduced-motion`:** disable marquee, cursor smoothing easing, and non-essential transitions.

---

## 5. Layout System

### 5.1 Workspace shell (calm cockpit)
```
┌───────────────────────────────────────────────────────────┐
│ Top bar: workspace ▸ project · presence avatars · call · ⚙ │
├──────────┬──────────────────────────────────┬─────────────┤
│ Left rail│         Primary surface           │ Right panel │
│ file tree│   (Canvas | Code | mixed split)   │ chat / AI / │
│ / layers │                                    │ activity    │
├──────────┴──────────────────────────────────┴─────────────┤
│ Bottom dock: shared terminal / preview / test results       │
└───────────────────────────────────────────────────────────┘
```
- Neutral surfaces (`--bg`, `--bg-raised`), hairline `--border` separators, accent used sparingly (active states, primary action). **No color blocking here.**
- Dockable, resizable panels; presets: *Code focus*, *Canvas focus*, *Split*, *Meeting*. Layout saved to `users.prefs.layout`.

### 5.2 Marketing / dashboard / onboarding (expressive edge)
- Oversized `display-xl` headers, `--bg-inverse` color blocks with terracotta accent, editorial index numerals, marquee ticker (e.g., live "N teams building now"), asymmetric grid, generous whitespace.
- Template picker cards per segment (dev starter / class assignment / wireframe board).

### 5.3 Responsive breakpoints
| Breakpoint | Range | Behavior |
|---|---|---|
| Desktop L | ≥1280px | Full multi-panel |
| Desktop | 1024–1279 | Multi-panel, narrower rails |
| Tablet | 768–1023 | Two panels max; others as tabs |
| Mobile | <768 | Single panel + bottom tab bar (Canvas view / Chat / Participants) |

---

## 6. Component Inventory

Mode key: **[C]** calm cockpit · **[E]** expressive edge.

| Component | Mode | Notes / states |
|---|---|---|
| App shell / top bar | C | breadcrumb, presence avatars (colored rings), call btn, settings |
| File tree | C | expand/collapse, context menu, drag-move, active file |
| Code editor | C | multi-cursor (collaborator colors + name labels), selection tint (~20% alpha), gutter (line#, fold, breakpoint), diff-by-user |
| Canvas toolbar | C | tool select, color, brush size/opacity, undo/redo |
| Canvas | C | live remote cursors + labels, selection handles, layer overlay |
| Layers panel | C | reorder, visibility, lock |
| Chat panel | C | message list, rich composer, mention autocomplete, reactions, threads, search; code blocks use mono + editor highlighting |
| AI panel | C | assistant chat, inline ghost-text completion (accent-soft), accept/reject |
| Video tiles | C | speaking ring (collaborator color), mute/video state, screen-share, pin, recording dot (`--error`) |
| Participant list | C | online/offline/speaking, role badge |
| Activity feed | C | real-time entries; on dashboard may render as **[E]** marquee |
| Presence avatars | C | stacked, colored ring = collaborator color |
| Buttons | both | primary = `--accent-strong` fill + white; secondary = `--border` outline; ghost = text; sizes sm/md/lg |
| Invite modal | C | scope, expiry, requireLogin, singleUse, copy link/email |
| Roles/members panel | C | role dropdown, remove |
| Settings | C | profile, theme, shortcuts editor, layout presets, notifications, integrations, data controls |
| Command palette | C | fuzzy actions + shortcuts, mono hints |
| Toasts / notification center | C | invites, mentions, session events |
| Onboarding tour / template picker | E | oversized type, color blocks, per-segment templates |
| Replay / timeline scrubber | C | play/pause, step, seek |
| Terminal / preview / test dock | C | tabs, mono output stream |
| Landing / marketing | E | display-xl hero, `--bg-inverse` blocks, marquee, asymmetric grid |
| Empty states | E | big `display-l` numeral/heading + terracotta CTA |

Every component ships: default / hover / focus / active / disabled / loading / error / empty — in **light + dark**.

---

## 7. Collaborator Identity System

- Stable color per user from §2.4; used consistently across cursor, selection tint, avatar ring, name label, attribution, activity feed.
- Name labels near remote cursors auto-fade when idle; label bg = collaborator color, text = pre-paired AA color.
- This consistency is a **hard requirement**, core to "real-time made visible."

---

## 8. Accessibility Spec

- Full keyboard navigation; visible focus ring (`--accent-strong`, 2px, offset) on all interactive elements.
- ARIA roles/labels for chat, file tree, participant list, toolbars, canvas layer list.
- **AA contrast in both themes** — validate collaborator palette + accent usage (§9). Terracotta accent restricted to large/bold per §2.2.
- Reduced-motion mode (§4.4).
- Canvas: object/layer list as text-accessible alternative; exports include alt where possible.
- Throttled screen-reader announcements for key real-time events (user joined, mention received).
- Never encode meaning by color alone — pair collaborator color with name/initials; pair semantic color with icon/text.

---

## 9. Token Validation (required in implementation)

Ship a small validator (runs in CI) that asserts:
1. All text/background pairings from the token set meet **WCAG AA** (≥4.5:1 body, ≥3:1 large/UI) in both themes.
2. Each collaborator color meets AA against its **paired label text**, and is distinguishable under common colorblindness simulations (deuteranopia/protanopia/tritanopia) and from the terracotta brand.
3. `--accent` (small-text) usage is flagged; small text on accent must use `--accent-strong`.
Fail = build fails (mirrors `rules.md §8`).

---

## 10. Implementation Notes

- Encode tokens as CSS custom properties (§2.5) + a typed `theme.ts` in `/packages/ui`; all components consume tokens, **no hardcoded colors/spacing** (`rules.md §8.6`).
- Load fonts self-hosted (`woff2`), `font-display: swap`; subset to used weights.
- Keep the **expressive/calm split** enforced structurally: marketing/onboarding components live in their own package/route group and may import "expressive" primitives (color blocks, marquee, display-xl); workspace components must not.

**Status:** `TBD-REF` markers resolved; `design.md` promoted to **v1.0**. Update `tracker.md` (design.md → ✅) and log the design decision.
```
