# Speed gate (bench results)

Command: `node design/bench/bench.js design/bench/sac-sidebar` (31/10/2026, Node 18.19.1, load average about 3, 16 GB in use by other sessions).
Real Chrome (playwright headless shell) + the SAC's own Tailwind 3.4.19 with the SAC `tailwind.config.js` as preset.
Percentiles are nearest-rank over 10 runs.

| medida | runs | p50 | p90 | min | max | gate | ok |
|---|---|---|---|---|---|---|---|
| primeira abertura (chrome + tailwind + render claro+escuro) | 10 | 2839 ms | 2915 ms | 2747 ms | 3060 ms | < 3000 ms | sim (p50); p90 sim |
| ajuste (salvar -> build -> render claro+escuro) | 10 | 321 ms | 356 ms | 297 ms | 367 ms | p90 < 1000 ms | sim |

**GATE: PASS** (adjustment p90 356 ms < 1000 ms; cold start p50 2839 ms and p90 2915 ms < 3000 ms).

Caveats, stated plainly:
- Cold start has little margin: 1 of 10 runs was 3060 ms (over 3000). Startup is about 2.5 s, almost all of it the Tailwind first build (Chrome launch alone is 60-90 ms). Cold render of both themes adds about 300-360 ms.
- Adjustment is about 30-50 ms Tailwind build + about 270-325 ms for two renders (light + dark, serialized). It does not include the plugin's file-watch latency (poll interval) or the component expansion step, which the bench does inline.
- The brand/extra CSS is inlined into a copy of the page at render time, so Chrome never serves a stale stylesheet.
- No sass binary in the SAC: `_next-colors.scss` is reduced to its plain custom-property blocks (`:root`, `.dark`), which is all it contains that matters here.
