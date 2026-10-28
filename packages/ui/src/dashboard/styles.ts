// Styles for the dashboard components. They read the tokens in `tokens.ts`.
export const dashboardCss = `
.ab-dashboard { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.ab-card { background: var(--ab-surface); border: 1px solid var(--ab-border); border-radius: 8px; padding: 12px 16px; position: relative; min-width: 0; }
.ab-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.ab-card h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ab-text); }
.ab-card h4 { margin: 4px 0 8px; font-size: 13px; font-weight: 600; color: var(--ab-text-2); }
.ab-sub, .ab-muted { color: var(--ab-muted); }
.ab-sub { margin: 2px 0 0; font-size: 12px; }
.ab-small { font-size: 12px; }
.ab-text { color: var(--ab-text); }
.ab-mono { font-family: var(--ab-mono); font-size: 12px; }
.ab-num { font-variant-numeric: tabular-nums; }
.ab-empty { color: var(--ab-muted); font-size: 13px; margin: 8px 0; }
.ab-table-wrap { overflow-x: auto; }
.ab-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ab-table th { text-align: left; font-weight: 600; color: var(--ab-text-2); border-bottom: 1px solid var(--ab-axis); padding: 6px 8px; white-space: nowrap; }
.ab-table td { border-bottom: 1px solid var(--ab-grid); padding: 6px 8px; vertical-align: top; color: var(--ab-text); }
.ab-plain-list { list-style: none; margin: 0; padding: 0; }
.ab-link-button { background: none; border: none; color: var(--ab-accent); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; text-underline-offset: 2px; }
.ab-status { white-space: nowrap; font-size: 12px; }
.ab-status::first-letter { font-weight: 700; }
.ab-tone-good { color: var(--ab-good); }
.ab-tone-warning { color: var(--ab-warning); }
.ab-tone-serious { color: var(--ab-serious); }
.ab-tone-critical { color: var(--ab-critical); }
.ab-tone-muted { color: var(--ab-muted); }
.ab-tone-accent { color: var(--ab-accent); }
.ab-meter { display: inline-flex; align-items: center; gap: 6px; }
.ab-meter-track { display: inline-block; width: 64px; height: 6px; border-radius: 3px; background: var(--ab-grid); overflow: hidden; }
.ab-meter-fill { display: block; height: 100%; border-radius: 3px; }
.ab-fill-accent { background: var(--ab-accent); }
.ab-fill-warning { background: var(--ab-warning); }
.ab-fill-critical { background: var(--ab-critical); }
.ab-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; list-style: none; margin: 0 0 6px; padding: 0; font-size: 12px; color: var(--ab-text-2); }
.ab-legend li { display: inline-flex; align-items: center; gap: 6px; }
.ab-key-line { display: inline-block; width: 14px; height: 2px; border-radius: 1px; vertical-align: middle; margin-right: 4px; }
.ab-key-rect { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.ab-grid { stroke: var(--ab-grid); stroke-width: 1; }
.ab-axis { stroke: var(--ab-axis); stroke-width: 1; }
.ab-crosshair { stroke: var(--ab-muted); stroke-width: 1; }
.ab-ceiling { stroke: var(--ab-text-2); stroke-width: 1; }
.ab-ref { stroke: var(--ab-muted); stroke-width: 1; }
.ab-tick, .ab-ref-label { fill: var(--ab-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.ab-value-label { fill: var(--ab-text-2); font-size: 10px; }
.ab-chart-box { position: relative; }
.ab-chart-box svg { width: 100%; height: auto; display: block; overflow: visible; }
.ab-chart-box svg:focus-visible { outline: 2px solid var(--ab-accent); outline-offset: 2px; }
.ab-tooltip { position: absolute; transform: translate(-50%, -100%); pointer-events: none; background: var(--ab-surface-2); border: 1px solid var(--ab-border); border-radius: 6px; padding: 6px 8px; font-size: 12px; color: var(--ab-text-2); white-space: nowrap; z-index: 2; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.ab-tooltip-title { color: var(--ab-muted); margin-bottom: 2px; }
.ab-tooltip-row { display: flex; align-items: center; gap: 6px; }
.ab-tooltip-row strong { color: var(--ab-text); font-variant-numeric: tabular-nums; }
.ab-multiples { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.ab-usage-panel { margin: 0; }
.ab-usage-panel figcaption { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; margin-bottom: 4px; color: var(--ab-text); }
.ab-usage-panel figcaption .ab-status { margin-left: auto; }
.ab-scroll-x { overflow-x: auto; }
.ab-flow { display: block; }
.ab-flow-stage { fill: var(--ab-muted); font-size: 11px; }
.ab-flow-stage-active { fill: var(--ab-text); font-weight: 600; }
.ab-flow-active-col { fill: var(--ab-surface-2); }
.ab-flow-lane { fill: var(--ab-text-2); font-size: 12px; }
.ab-flow-count { fill: var(--ab-text-2); font-size: 10px; paint-order: stroke; stroke: var(--ab-surface); stroke-width: 3px; }
.ab-flow-node { stroke: var(--ab-surface); stroke-width: 2; }
.ab-health-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.ab-funnel { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px; }
.ab-funnel li { display: grid; grid-template-columns: 76px 1fr 36px; align-items: center; gap: 8px; font-size: 12px; color: var(--ab-text-2); }
.ab-funnel-track { display: block; height: 14px; }
.ab-funnel-bar { display: block; height: 100%; border-radius: 0 4px 4px 0; min-width: 2px; }
.ab-tiles { display: flex; gap: 12px; flex-wrap: wrap; }
.ab-tile { display: flex; flex-direction: column; gap: 2px; background: var(--ab-surface-2); border-radius: 6px; padding: 8px 10px; min-width: 120px; }
.ab-tile-label { font-size: 12px; color: var(--ab-text-2); }
.ab-tile-value { font-size: 22px; font-weight: 600; color: var(--ab-text); }
.ab-filter-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--ab-text-2); font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .ab-flow-pulse { display: none; } }
@media (forced-colors: active) { .ab-key-line, .ab-key-rect { forced-color-adjust: none; } }
`;
