# BrewDock Dashboard Design System

Reference document for the dashboard UI. All styling uses CSS custom properties defined in `apps/web/app/globals.css` for light/dark mode support.

## Color Tokens

Defined as CSS variables on `:root`, with overrides in `@media (prefers-color-scheme: dark)`, `body.dark`, and `body.light`.

| Token                    | Light           | Dark            | Usage                     |
|--------------------------|-----------------|-----------------|---------------------------|
| `--bg-main`              | `#ffffff`       | `#0a0a0a`       | Page background           |
| `--bg-sidebar`           | `#f7f7f8`       | `#111111`       | Sidebar background        |
| `--bg-surface`           | `#ffffff`       | `#171717`       | Cards, panels             |
| `--bg-hover`             | `#f1f3f5`       | `#262626`       | Hover states, badge bg    |
| `--bg-active`            | `#e9ecef`       | `#333333`       | Active/pressed states     |
| `--border-color`         | `#eaeaea`       | `#333333`       | All borders               |
| `--text-primary`         | `#111827`       | `#f3f4f6`       | Headings, body text       |
| `--text-secondary`       | `#6b7280`       | `#9ca3af`       | Descriptions, labels      |
| `--accent-color`         | `#2ea043`       | `#3fb950`       | Active sidebar item, links|
| `--btn-primary-bg`       | `#111111`       | `#ececec`       | Primary buttons           |
| `--btn-primary-text`     | `#ffffff`       | `#111111`       | Primary button text       |
| `--btn-primary-hover`    | `#333333`       | `#ffffff`       | Primary button hover      |
| `--btn-secondary-bg`     | `#ffffff`       | `#111111`       | Secondary buttons         |
| `--btn-secondary-text`   | `#111827`       | `#f3f4f6`       | Secondary button text     |
| `--btn-secondary-border` | `#eaeaea`       | `#333333`       | Secondary button border   |
| `--btn-secondary-hover`  | `#f9fafb`       | `#1f1f1f`       | Secondary button hover    |

## Typography

### Body Font
`-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif`
Set on `<body>` in globals.css.

### Logo Font
`IBM Plex Serif` loaded via `next/font/google` in `apps/web/app/layout.tsx`, exposed as `--font-ibm-plex-serif`.
- Size: 28px
- Weight: 400
- Letter-spacing: -0.5px
- Color: `var(--text-primary)`

### Headings

**h1 (page titles)** -- defined in `.page-header h1`:
- Size: 24px
- Weight: 600
- Letter-spacing: -0.5px
- Color: `var(--text-primary)`

**h2 (section titles in settings panels)** -- defined in `.settings-panel h2`:
- Size: 16px
- Weight: 600
- Color: `var(--text-primary)`
- Margin-bottom: 12px

When using h2 outside `.settings-panel` (e.g. in cards), apply the same values via inline style:
```
style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}
```

### Body Text
- Primary text: 13px, `var(--text-primary)`
- Secondary/description text: 13px, `var(--text-secondary)`
- Labels in settings rows: 12px, `var(--text-secondary)`

## Layout

### Sidebar (`.sidebar`)
- Width: 240px
- Background: `var(--bg-sidebar)`
- Border-right: 1px solid `var(--border-color)`
- Full viewport height, flex column

**Logo container:** `padding: 24px 16px 8px 24px`, flex, center-aligned, gap 10px.

**Nav items (`.sidebar-item`):** 13px, font-weight 500, padding `8px 12px`, gap 8px. Active state uses `var(--accent-color)` with 10% opacity background.

### Page Header (`.page-header`)
- Padding: `48px 64px 24px`
- Background: `var(--bg-main)`
- Contains h1 and optional description `<p>`

### Page Content (`.page-content`)
- Padding: `0 64px 48px`
- `flex: 1`, `overflow-y: auto` (scrollable)

## Components

### Settings Panel (`.settings-panel`)
Card container used throughout settings and dashboard.
- Background: `var(--bg-surface)`
- Border: 1px solid `var(--border-color)`
- Padding: 24px
- Margin-bottom: 24px
- Box-shadow: `0 1px 3px rgba(0,0,0,0.05)`
- No border-radius

Use `settings-panel` class instead of `border border-gray-200 bg-white p-6`.

### Settings Row (`.settings-row`)
Label + input pair inside a settings panel.
- Flex, center-aligned, gap 10px, margin-bottom 8px
- Label: 12px, 200px wide, `var(--text-secondary)`
- Input: max-width 340px, 13px, `var(--bg-main)` background, border focus uses `var(--btn-primary-bg)`

### Settings Actions (`.settings-actions`)
Button group, typically at the bottom of a settings panel.
- Flex, center-aligned, gap 10px, margin-top 12px
- Buttons: 13px, font-weight 500, padding `8px 16px`, `var(--btn-primary-bg)` background, no border-radius

### Metadata Badges
Used on the dashboard overview to show session metadata (time ago, duration, action count). Each badge:
- `inline-flex items-center gap-1.5 px-2.5 py-1`
- Font: 12px (`text-xs`), font-weight 500
- Color: `var(--text-secondary)`
- Background: `var(--bg-hover)`
- Border: `1px solid var(--border-color)`
- Contains a Lucide icon (size 12) + text label
- Icons used: `Clock` (time ago), `Timer` (duration), `Zap` (action count)

Example:
```tsx
<span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]"
  style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
  <Clock size={12} />
  51m ago
</span>
```

### Status Badges
Colored badges for action statuses in tables.
- `inline-block px-2 py-0.5 text-xs font-medium capitalize`
- Colors: approved (blue-100/blue-700), executed (green-100/green-700), rejected (red-100/red-700), undone (gray-100/gray-600)

### Primary Button (inline style pattern)
```
style={{
  background: "var(--btn-primary-bg)",
  color: "var(--btn-primary-text)",
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 500,
  border: "none"
}}
```

## Tailwind Usage Notes

This project uses Tailwind CSS v4. When referencing CSS variables in Tailwind classes, use bracket notation:
- `text-[var(--text-secondary)]`
- `bg-[var(--bg-surface)]`
- `border-[var(--border-color)]`

Do not use hardcoded Tailwind color classes like `bg-gray-200`, `text-gray-500`, `border-gray-300`, etc. Always use the CSS variable equivalents.

## Table Styling

Table rows use `py-3` (12px vertical padding) for comfortable spacing. Table headers use `text-xs font-medium text-[var(--text-secondary)]` with `bg-[var(--bg-surface)]`.
