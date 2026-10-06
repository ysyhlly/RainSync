# RainSync unified interface contract

The approved modular room is the visual reference. Shared CSS remains backward-compatible; do not change playback or modular grid geometry.

## Tokens

- Canvas `--surface-canvas: #f5f0e6`; panel `--surface-panel: #fcf9f2`; muted `--surface-muted: #eee6d9`
- Text `--text-primary: #392d26`; secondary `--text-secondary: #756557`
- Accent `--accent: #d7bda5`; soft `--accent-soft: #efe2d1`; on accent `--text-on-accent: #392d26`
- Borders `--border-subtle: #e2d7c8`; control `--border-control: #a1846d`; focus `--focus-ring: #785943`
- Fonts `--font-sans` system sans, `--font-size-xs: 12px`, `--font-size-sm: 13px`, `--font-size-base: 15px`, `--font-size-lg: 17px`, `--font-size-xl: 20px`, `--font-size-2xl: 26px`, `--font-size-3xl: 32px`
- Spacing `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 20px`, `--space-6: 24px`, `--space-8: 32px`, `--space-10: 40px`, `--space-12: 48px`
- `--radius-control: 11px`, `--radius-widget: 12px`, `--radius-panel: 16px`, `--radius-small: 8px`, `--radius-pill: 999px`
- `--control-height: 44px`; `--shadow-panel` subtle warm shadow; `--shadow-floating` dialog shadow

## Existing global classes to keep using

- `.page`, `.page-title` (heading + description + actions), `.panel`, `.helper`, `.section-label`
- `button`, `.button` are 44px minimum; `.primary`, `.danger`, `.icon-button`, `.text-button`
- `.button-row`, `.form-field`, `.password-field`, `.notice`, `.notice.error`, `.empty-state`, `.loading-state`
- `.app-dialog`, `.dialog-body`, `.dialog-actions`, `.confirm-panel`
- Existing component classes remain valid. Do not add hard-coded page palettes.

## Additive shared classes (available with shared system integration)

- `.page-intro`: small uppercase-style eyebrow via `.page-eyebrow`, heading and supporting text; use within `.page-title`
- `.surface-card`: panel background/border/radius/shadow, 24px padding (20px mobile); `.surface-card--compact` 16px
- `.section-heading`: wrapping row for title/description and actions; `.section-heading__copy` flexible text group
- `.page-stack`: vertical layout, 24px gap; `.content-grid`: auto-fit cards, 280px minimum; mobile single-column
- `.toolbar`: wrapping bordered soft panel, 12px gap, 16px padding; `.toolbar__field` flexible search with min-width 200px; `.toolbar__actions` wrapping action row
- `.segmented-nav`: wrapping pill/tab-like navigation group; add `aria-current="page"` on links or `aria-pressed="true"` on buttons for selected state; preserve actual navigation semantics
- `.status-badge`: compact neutral badge; `.status-badge--success`, `--warning`, `--danger` when semantics apply
- `.stat-grid`: responsive 3-column count group; `.stat-card`, `.stat-card__label`, `.stat-card__value`, `.stat-card__meta`
- `.empty-state--compact`: 200px minimum; `.empty-state__icon`: 48px muted rounded icon tile
- `.loading-state--inline`: compact centered loading region; `.skeleton`: reduced-motion-safe neutral placeholder
- `.notice.success`, `.notice.warning`: semantic states; use role="status" for informative results and role="alert" for actionable errors
- `.field-hint`: supporting 13px text; `.field-error`: danger text, connect using aria-describedby
- `.data-list`: grid with 12px gap; `.data-row`: wrapping card row with 16px padding; `.data-row__body`: flexible min-width:0 content; `.data-row__actions`: wrapping actions
- `.subtle-divider`: full-width neutral border divider

## Page work ownership

Shared system owns global styles and visual shell. Feature workers own Page files and may add scoped structural CSS using these tokens. Avoid overriding shared colors, button geometry, typography families or dialog chrome. Keep one obvious primary action per region, icon-only controls labeled, forms semantic, and empty/error/loading states distinct. Mobile controls need 44px targets and no horizontal page scrolling.
