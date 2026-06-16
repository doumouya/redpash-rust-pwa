# wasm vs native — RedPash data engine (wide corpus)

One engine, two surfaces. **wasm = `-Oz` (the *shipped* build) in a node host**; **native = `--release`** (opt-level 3, multi-threaded). Each cell is the **median** of K warmed runs (K=6, 4 at ≥250k; W=2 warmup). Windowed ops include `Page::to_json().to_string()` on BOTH surfaces (marshal parity). Absolutes are machine-relative (WSL2) — **read the ratio**, not the milliseconds.

> Caveats baked in: node ≠ a real browser main thread (no render contention / freeze) — the cap decision needs a browser pass. `-Oz` is size-optimized; an `-O3` wasm would narrow the ratio (named follow-on). The wasm number carries the JS↔wasm boundary the native number can't.

### parse

| rows | wasm `-Oz` (ms) | native (ms) | wasm / native |
|--:|--:|--:|--:|
| 1,000 | 8.901 | 12.202 | 0.73× |
| 10,000 | 31.673 | 22.931 | 1.38× |
| 50,000 | 108.997 | 63.677 | 1.71× |
| 100,000 | 200.059 | 111.279 | 1.8× |
| 250,000 | 526.297 | 241.742 | 2.18× |
| 500,000 | 1025.098 | 502.036 | 2.04× |

### page

| rows | wasm `-Oz` (ms) | native (ms) | wasm / native |
|--:|--:|--:|--:|
| 1,000 | 1.595 | 0.627 | 2.54× |
| 10,000 | 1.527 | 0.537 | 2.84× |
| 50,000 | 1.062 | 0.454 | 2.34× |
| 100,000 | 1.353 | 0.502 | 2.7× |
| 250,000 | 1.109 | 0.452 | 2.45× |
| 500,000 | 1.005 | 0.495 | 2.03× |

### filter

| rows | wasm `-Oz` (ms) | native (ms) | wasm / native |
|--:|--:|--:|--:|
| 1,000 | 4.859 | 24.294 | 0.2× |
| 10,000 | 6.447 | 51.934 | 0.12× |
| 50,000 | 15.595 | 39.789 | 0.39× |
| 100,000 | 27.776 | 50.561 | 0.55× |
| 250,000 | 50.84 | 39.793 | 1.28× |
| 500,000 | 99.845 | 47.876 | 2.09× |

### search

| rows | wasm `-Oz` (ms) | native (ms) | wasm / native |
|--:|--:|--:|--:|
| 1,000 | 23.445 | 32.764 | 0.72× |
| 10,000 | 54.749 | 58.489 | 0.94× |
| 50,000 | 166.475 | 140.308 | 1.19× |
| 100,000 | 283.84 | 192.661 | 1.47× |
| 250,000 | 685.972 | 371.856 | 1.84× |
| 500,000 | 1598.558 | 590.393 | 2.71× |

### sort

| rows | wasm `-Oz` (ms) | native (ms) | wasm / native |
|--:|--:|--:|--:|
| 1,000 | 1.324 | 4.874 | 0.27× |
| 10,000 | 3.254 | 5.036 | 0.65× |
| 50,000 | 6.47 | 9.486 | 0.68× |
| 100,000 | 8.699 | 10.975 | 0.79× |
| 250,000 | 22.795 | 70.651 | 0.32× |
| 500,000 | 48.83 | 100.094 | 0.49× |

### score

| rows | wasm `-Oz` (ms) | native (ms) | wasm / native |
|--:|--:|--:|--:|
| 1,000 | 22.868 | 18.849 | 1.21× |
| 10,000 | 172.278 | 185.422 | 0.93× |
| 50,000 | 713.805 | 667.793 | 1.07× |
| 100,000 | 1497.357 | 1631.671 | 0.92× |
| 250,000 | 4527.764 | 4279.597 | 1.06× |
| 500,000 | 8556.953 | 8418.919 | 1.02× |

### memory + JS-side marshal

| rows | wasm linear mem (MB) | wasm proc rss (MB) | native rss (MB) | `JSON.parse` a page (ms) |
|--:|--:|--:|--:|--:|
| 1,000 | 20.5 | 280.7 | 43.3 | 0.174 |
| 10,000 | 52 | 266.9 | 82.9 | 0.16 |
| 50,000 | 203.9 | 481.8 | 162.9 | 0.149 |
| 100,000 | 381 | 613.4 | 284.8 | 0.11 |
| 250,000 | 819.3 | 1073.9 | 531.1 | 0.14 |
| 500,000 | 1672.1 | 1993 | 1074.8 | 0.132 |

### cliffs — first size where the **wasm** op median crosses

| op | ≥ 100 ms | ≥ 1 s |
|--|--:|--:|
| parse | 50,000 | 500,000 |
| page | — | — |
| filter | — | — |
| search | 50,000 | 500,000 |
| sort | — | — |
| score | 10,000 | 100,000 |

ROW_CAP = 500,000 (the client buffer + server clamp). The binding cap is set by the **full-scan ops (parse, score)**, not the windowed ones (page).
