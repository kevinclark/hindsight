# Measurements (2026-10-19)

Machine: the M5 Max MacBook Pro this was built on. Browser: Google Chrome 155.0.8059.80, headless (`--headless=new`),
fresh profile, `--enable-precise-memory-info`. Page: `hindsight.html` opened from `file://`. Logs loaded through the
page's own `<input type=file>` (CDP `DOM.setFileInputFiles`), so the real File → ArrayBuffer path is timed.
Script: `scripts/chrome-check.ts`. Each row is a fresh page in a fresh Chrome; three runs each.

| Load | Read files | Index + match model | All rules | Drop to rendered (wall) | JS heap after | Renderer RSS added at peak |
|---|---|---|---|---|---|---|
| Q13 (52.6 MB) + its .dslog | 16–17 ms | 56 ms | 60–61 ms | 198–200 ms | 82–83 MB | +146–147 MB |
| Q21 (54.1 MB) | 17–18 ms | 56–58 ms | 59–60 ms | 195–199 ms | 79–80 MB | +184 MB |
| P0 (56.5 MB) | 18 ms | 63 ms | 68–69 ms | 243–244 ms | 86–87 MB | +189 MB |
| All three + the .dslog | 21–22 ms | 48–56 ms each | 52–62 ms each | 400–402 ms | 244–246 MB | +323–324 MB |

- "All rules" includes decoding every signal the rules ask for (the reader decodes lazily) and the power model.
- "Renderer RSS added at peak": the largest sum of resident memory over this Chrome's renderer processes, sampled every
  50 ms during the load, minus the sum before the drop (≈ 773 MB across Chrome's renderer processes at idle). The JS
  heap figure is `performance.memory.usedJSHeapSize` after the page rendered.
- Node 26 on the same machine (`scripts/check.ts`): index 49–58 ms, rules 47–62 ms per log.

Not measured: Windows or Chromebook laptops, older/slower hardware, Safari timing (Safari was checked for rendering
only, through a test page with the logs embedded, because Safari's WebDriver is disabled on this Mac).

## Rendering checks

- Browser pane (Chromium, served from localhost because the pane can't open `file://`): both tabs, all three logs,
  375 px wide (no horizontal scroll).
- Chrome 155 from `file://` via the file input: both tabs, all three logs (screenshots in the session, not committed).
- Safari from `file://`: both tabs for Q13, Q21 and P0, via a test copy of `hindsight.html` with the log embedded
  (made outside the repo; the real file-picker path in Safari is not exercised).
