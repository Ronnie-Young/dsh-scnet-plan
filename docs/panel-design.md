# SCNet Plan Panel — Redesign Spec

Scope: `client.js` → `PlanPanel` / `UsageDetails` / `Catalog` + the `const CSS` block. Plain `React.createElement`, CSS variables only, all classes keep the `scp-` prefix. Target column: 880px.

---

## 1. Diagnosis — why the current panel reads "ugly / cluttered"

Measured against `/tmp/before.png`:

1. **Box-in-box-in-box.** The page renders 4 outer `.scp-card`s; the hero card alone nests **9 bordered `.scp-stat` boxes** (4 quota + 5 token boxes), each with its own border, layer-2 fill and 10px radius. ~30 visible rectangles compete on one screen; nothing wins, so everything feels like noise.
2. **The black ring is the loudest object on the page.** A 112px conic ring in solid `--brand` (#0f1115) sits left of the stats, yet it encodes *less* information than the "剩余 1.36 万" stat next to it. It also duplicates: ring says "23% 剩余", stat says "剩余 1.36 万 Credits", badge says "有效" — the same fact stated 3 ways within 400px.
3. **9 equal-weight stat boxes = no hierarchy.** 月度额度 / 已用 / 剩余 / 生效 / 输入 / 缓存 / 输出 / 日均 / 峰值 are all 15px/600 in identical boxes. The one number the user opens the panel for (剩余) has the same weight as 缓存命中.
4. **Oversized, mostly-empty heatmap.** 7-col grid at `max-width:420px` → ~52px cells, ~340px tall for a 31-day period where only 2 days have data. Two filled cells (one mid-gray, one **solid black h5**) shout over an ocean of layer-2 gray empties. The 6-swatch legend adds a 7th gray row. Result: the biggest visual mass on the page carries ~2 bits of information.
5. **Pill/badge overuse.** Green pill `有效`, black pill `当前`, 18 model pills, tier pills — 20+ rounded-full elements, each a separate outline. In a monochrome UI, the green pill becomes the most saturated thing on screen and steals focus from the balance.
6. **Redundant period info.** 到期 (top-right), 生效→到期 (stat box), 剩余天数 (top-right), heatmap hint — 4 restatements of the same window.
7. **Color misuse in monochrome.** Solid-black fills (ring, h5 cell, tier border, primary-adjacent accents) + a green pill break DSH's near-neutral palette; the design system reserves full-strength color for *state*, not decoration.
8. **Date wrapping.** "2026/10/19 → 202 6/11/19" breaks mid-year inside a 160px box — a symptom of forcing long strings into small cards.

## 2. Information architecture

| Zone | Content | Treatment |
|---|---|---|
| Header | Title, **textual status** (dot + word, no pill), refresh button | Keep, restyle badge |
| **Hero (first screen)** | Plan name + code · **remaining Credits (hero number)** · used/total one-liner · slim progress bar · 剩余天数 + period dates in one line · billing link | One card, zero inner boxes |
| Usage row | input / cached / output tokens, daily avg, peak | 5 plain text stats in one hairline-divided row, **no boxes** |
| Heatmap | daily Credits | Keep, shrunk to 12px cells, neutral scale, only up to "today"; legend reduced to 少/多 with 4 steps |
| Collapsed `<details>` "套餐与模型" | Catalog tiers (compact list, not cards) + model names (comma text, not pills) + source/updated/cookie meta | Collapsed by default |
| Deleted | the ring, `生效` stat box, `剩余` stat box (merged into hero), 6-swatch legend, model pills, tier cards' borders, `heatmapHint` (folded into section title) | — |

## 3. Layout & spacing (880px column)

```
.page   padding: 24px 32px 48px; wrap max-width 880px, gap 24px (was 20)
header  title 17px/600 (was 20px — panel is a sub-view, not a page); subtitle 12px secondary; gap 4px
hero    padding 20px 24px; radius 12px; single border hairline; bg layer-1
  row1: plan name 15px/600 + code 12px secondary (baseline) ····· status dot+text right
  row2 (margin-top 14px): "剩余额度" 12px secondary
  row3 (margin-top 2px):  remaining 40px/650 tabular, letter-spacing -0.02em; unit "Credits" 13px secondary
  row4 (margin-top 4px):  "已用 4.62 万 / 共 6 万 · 已用 77%" 12.5px secondary, tabular
  row5 (margin-top 14px): progress bar h=4px radius 999, track layer-2, fill brand
  row6 (margin-top 10px): "剩余 31 天 · 2026/10/19 – 2026/11/19" 12px secondary left · "查看明细账单 ↗" link right
usage   margin-top 20px; section title 12px/600 secondary uppercase-ish
        one row, 5 cells, divided by 1px hairlines (border-left on cells 2..n), no fill, no radius
        cell: label 11.5px secondary lh 1.4 / value 16px/600 tabular, margin-top 4
heatmap margin-top 20px; title row: "每日 Credits 消耗" + bill link right (12px)
        grid: columns repeat(7, 12px), gap 3px, rows auto; cell 12px radius 3px
        legend: 11px secondary "少 [4 steps] 多", margin-top 8; no hint text (title already says daily)
details margin-top 4px; summary 12.5px secondary, chevron ▸ rotates on open
catalog inside details: definition rows "基础版 · 6 万 Credits/月" 13px, current tier gets `· 当前` in brand text (no pill, no border)
models  inside details: 13px secondary, comma-separated text, lh 1.8 (no pills)
meta    inside details, 11.5px tertiary-style secondary, "来源 console · 更新 10-20 13:44 · 每 300 秒 · Cookie 已保存"
```

Vertical rhythm: one 24px gap between header / hero / usage+heatmap card / details. Inside the hero card, nothing exceeds 14px gaps — the card is one object.

## 4. Typography & color rules

- All numerals: `font-variant-numeric: tabular-nums` on `.scp-num`, hero value, stat values, dates. Prevents jitter on refresh.
- Scale: 40/650 hero · 16/600 stat · 15/600 plan name · 13 body · 12 secondary · 11.5 micro. Line-heights 1.15 (hero), 1.4 (labels), 1.6 (notes).
- Light: bg `#fff`, card `#f9fafb` (layer1 on base) — *or* white card + hairline on `#f9fafb` page; pick card=`--dsw-alias-bg-layer-1`, page=`--dsw-alias-bg-base` as today. Hairlines `--dsw-alias-border-l1` only; **no second fill level inside cards** (kills box-in-box).
- Dark: tokens already map (bg #151517, layer1 #232324, layer2 #2c2c2e); the restraint rules matter more than the values — one fill level per surface.
- Status color: 6px dot + colored word only (`#22c55e / #f59e0b / #ec1313`), 12px/500. **Never a filled pill.**
- Progress bar: brand fill at 100% opacity, 4px tall. Tone variants only when left ≤ warnAt: warn amber, ≤ warnAt/3 red. Default = brand (black/white), not green.
- Heatmap: single-hue brand alpha ramp on transparent base: 0=layer-2 fill, 1=18%, 2=38%, 3=60%, 4=100% of `--brand`. 4 steps, not 6. Future/empty days render `transparent` (no square at all) — the grid simply ends at today. Peak day never becomes solid black *louder than the hero* because the hero number outweighs it 5:1 in size.

## 5. Ready-to-paste CSS (replaces the panel-relevant classes in `const CSS`)

```css
/* --- shell --- */
.scp-page{height:100%;overflow:auto;padding:24px 32px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);box-sizing:border-box}
.scp-wrap{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:24px}
.scp-num{font-variant-numeric:tabular-nums}

/* --- header --- */
.scp-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
.scp-title{margin:0;font-size:17px;font-weight:600;line-height:1.3}
.scp-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-head-actions{display:flex;align-items:center;gap:12px;flex:none}
.scp-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;white-space:nowrap}
.scp-status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.scp-status-ok{color:var(--dsw-alias-state-success-primary)}
.scp-status-warn{color:var(--dsw-alias-state-warn-primary)}
.scp-status-error{color:var(--dsw-alias-state-error-primary)}
.scp-status-idle{color:var(--dsw-alias-state-idle-primary)}
.scp-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;text-decoration:none}
.scp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.scp-btn:disabled{opacity:.5;cursor:default}
.scp-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}

/* --- card: one fill level, one hairline, nothing nested inside gets a border --- */
.scp-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:20px 24px}
.scp-card-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1))}
.scp-section-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}

/* --- hero --- */
.scp-plan-line{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.scp-plan-name{display:flex;align-items:baseline;gap:8px;font-size:15px;font-weight:600}
.scp-plan-name span{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.scp-hero-label{margin-top:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-hero-value{display:flex;align-items:baseline;gap:8px;margin-top:2px}
.scp-hero-value b{font-size:40px;font-weight:650;letter-spacing:-.02em;line-height:1.1}
.scp-hero-value span{font-size:13px;color:var(--dsw-alias-label-secondary)}
.scp-hero-sub{margin-top:4px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.scp-bar{margin-top:14px;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.scp-bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.scp-bar-warn i{background:var(--dsw-alias-state-warn-primary)}
.scp-bar-error i{background:var(--dsw-alias-state-error-primary)}
.scp-hero-foot{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-link{color:var(--dsw-alias-label-primary);text-decoration:none;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.scp-link:hover{border-color:var(--dsw-alias-label-primary)}

/* --- usage row: hairline-divided text stats, no boxes --- */
.scp-usage{margin-top:20px}
.scp-usage-row{display:flex;margin-top:12px}
.scp-ucell{flex:1;min-width:0;padding:0 16px}
.scp-ucell:first-child{padding-left:0}
.scp-ucell+.scp-ucell{border-left:1px solid var(--dsw-alias-border-l1)}
.scp-ucell span{display:block;font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.scp-ucell b{display:block;margin-top:4px;font-size:16px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;white-space:nowrap}

/* --- heatmap: small, quiet, ends at today --- */
.scp-subhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:20px}
.scp-heatmap{display:grid;grid-template-columns:repeat(7,12px);gap:3px;margin-top:12px}
.scp-heat{width:12px;height:12px;border-radius:3px;background:var(--dsw-alias-bg-layer-2)}
.scp-h1{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,var(--dsw-alias-bg-layer-2))}
.scp-h2{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-bg-layer-2))}
.scp-h3{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,var(--dsw-alias-bg-layer-2))}
.scp-h4{background:var(--dsw-alias-brand-primary)}
.scp-heat-legend{display:flex;align-items:center;gap:5px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.scp-heat-legend i{width:10px;height:10px;border-radius:2.5px;display:inline-block}

/* --- collapsed details --- */
.scp-details{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px 24px}
.scp-summary{cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);user-select:none;list-style:none;display:flex;align-items:center;gap:8px}
.scp-summary::-webkit-details-marker{display:none}
.scp-summary::before{content:"▸";font-size:10px;transition:transform .15s ease}
.scp-details[open] .scp-summary::before{transform:rotate(90deg)}
.scp-summary:hover{color:var(--dsw-alias-label-primary)}
.scp-detail-body{margin-top:14px;display:flex;flex-direction:column;gap:14px}
.scp-kv{display:grid;grid-template-columns:150px 1fr;gap:8px 16px;font-size:13px}
.scp-kv div:nth-child(odd){color:var(--dsw-alias-label-secondary)}
.scp-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:0}
.scp-note b{color:var(--dsw-alias-label-primary);font-weight:600}
.scp-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.8}

/* --- states (loading / error / login) unchanged semantics, quieter chrome --- */
.scp-skeleton{height:14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:scp-pulse 1.4s ease-in-out infinite}
@keyframes scp-pulse{0%,100%{opacity:.6}50%{opacity:1}}
.scp-error-msg{font-size:13px;font-weight:600;margin:0 0 6px}
.scp-code{font-size:11px;color:var(--dsw-alias-label-secondary)}
.scp-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:14px}
.scp-login{display:flex;flex-direction:column;gap:10px}
.scp-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.scp-input{width:100%;min-height:30px;box-sizing:border-box;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;resize:vertical}
.scp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.scp-tabs{display:flex;gap:6px;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);width:max-content}
.scp-tab{height:26px;padding:0 12px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.scp-tab-on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.scp-captcha{display:flex;align-items:center;gap:8px}
.scp-captcha-img{height:34px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:#fff}
.scp-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center}
.scp-code-row{display:flex;gap:8px}
.scp-code-row .scp-input{flex:1;width:auto}
.scp-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;line-height:1}
.scp-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.scp-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.scp-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.scp-dot-error{background:var(--dsw-alias-state-error-primary)}
.scp-dot-idle{background:var(--dsw-alias-state-idle-primary)}
.scp-icon{display:flex;align-items:center;justify-content:center;width:100%;height:100%}

/* --- removed: .scp-badge*, .scp-ring*, .scp-stat, .scp-grid, .scp-token-grid,
     .scp-usage-stats, .scp-plan-head*, .scp-plan-body, .scp-models, .scp-tag*,
     .scp-catalog, .scp-tier*, .scp-heat-empty, .scp-heat-hint, .scp-h5 --- */
```

Heatmap JS change: `heatmapDays` should stop at `min(periodEnd, today)` and drop leading-pad empty cells beyond first weekday; levels map `ceil(credits/max*4)` → `scp-h1..h4`, level 0 = base cell.

## 6. DOM tree (new panel)

```
section.scp-page
└─ div.scp-wrap
   ├─ header.scp-head
   │   ├─ div > h1.scp-title + p.scp-sub
   │   └─ div.scp-head-actions > span.scp-status.scp-status-{tone} · button.scp-btn 刷新
   ├─ article.scp-card                      ← hero, only card above the fold
   │   ├─ div.scp-plan-line > div.scp-plan-name(b,span code) · span.scp-status (stale warn if any)
   │   ├─ div.scp-hero-label  剩余额度
   │   ├─ div.scp-hero-value > b.scp-num 1.36 万 · span Credits
   │   ├─ div.scp-hero-sub.scp-num  已用 4.62 万 / 共 6 万 · 已用 77%
   │   ├─ div.scp-bar(.scp-bar-warn|.scp-bar-error) > i style width=usedPercent%
   │   └─ div.scp-hero-foot > span.scp-num 剩余 31 天 · 2026/10/19 – 2026/11/19 · a.scp-link 查看明细账单 ↗
   ├─ article.scp-card                      ← usage + heatmap
   │   ├─ h2.scp-section-title 用量消耗
   │   ├─ div.scp-usage-row > 5 × div.scp-ucell(span label, b.scp-num value)
   │   ├─ div.scp-subhead > span.scp-section-title 每日 Credits 消耗 · (no second link; bill link lives in hero)
   │   ├─ div.scp-heatmap > leading pads + cells span.scp-heat.scp-h{0..4} (title tooltip unchanged)
   │   └─ div.scp-heat-legend > 少 i×4 多
   └─ details.scp-details
       ├─ summary.scp-summary 套餐与模型
       └─ div.scp-detail-body
           ├─ div.scp-kv   当前套餐/各档位（每行 "标准版 · 24 万 Credits/月"，当前行尾部加 b · 当前）
           ├─ p.scp-note   可用模型 · 18：DeepSeek-V4.1-Flash, Kimi-K3, …   (text, no pills)
           └─ p.scp-meta   来源 console · 更新 10-20 13:44 · 每 300 秒 · Cookie 已保存 (+ stale warning if error)
```

`CookieCallout` and the error card keep their structure, inheriting the new `.scp-card`/`.scp-note`/`.scp-btn` chrome; `SettingsSection` is untouched except shared classes. `advancedManual` key already missing from dicts — add it or reuse `consoleCookie` as summary text.

## 7. Before → after rationale

| Before | After | Why |
|---|---|---|
| 112px solid ring "23% 剩余" | 40px remaining number + 4px progress bar | Ring duplicated the stat and dominated the page; bar keeps the proportion cue at 1/20th the visual weight |
| 9 bordered stat boxes | 5 hairline-divided text cells in one row | Box-in-box was the main clutter source; dividers keep scanability with zero fills |
| "剩余" stated 3× (ring, stat, bar %) | Stated once as hero, once as bar | One fact, one place |
| 4 period restatements | One footer line: days-left + full period | Removes the wrapping "202 6/11/19" bug and shrinks header |
| 52px heatmap cells, 6 levels, all-period grid incl. future | 12px cells, 4 levels, grid ends today | ~85% less area; empty future squares were pure noise; black peak cell no longer the loudest element |
| Green pill `有效` + black pill `当前` + 18 model pills | Dot + colored word; `· 当前` text; comma list | 20+ outlines → 0; saturation reserved for actual state |
| Tier cards with borders | Rows inside collapsed `<details>` | Catalog is reference material, not first-screen content |
| Meta card (4th card) | One 11.5px line inside details | Source/cookie info is diagnostic, not monitoring data |
| Header title 20px + 24px badge | 17px title + 12px status | Panel is a sub-view; header now quieter than the hero number, as hierarchy demands |

Expected result: first screen = 2 cards, ~15 visible text runs, 1 progress bar, 1 compact heatmap — same data, roughly a third of the previous visual mass.
