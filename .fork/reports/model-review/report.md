# Model review — 2026-10-15T08:10:41Z

Живые тиры: `mega` (4), `pro` (10), `flash` (14). Пороги: mega≥88, pro≥76, flash≥60; судятся только confidence high/medium.

Источники: `openrouter` 2026-10-15, `offline` пересчёт latest.json

## Перестановки (misplaced) (13)

| id | score | confidence | in_tier | belongs | blended_usd_per_m | arena_code |
|---|---|---|---|---|---|---|
| cohere/north-mini-code:free | 25.58 | high | flash | — (ниже flash-банда) | 0.0 | — |
| deepseek/deepseek-v4-flash | 57.08 | high | flash | — (ниже flash-банда) | 0.1138 | — |
| google/gemini-3.8-flash | 82.03 | high | flash | pro | 1.5 | — |
| moonshotai/kimi-k2.7-code | 61.46 | high | pro | flash | 1.3409 | — |
| moonshotai/kimi-k3 | 88.59 | high | pro | mega | 4.0875 | 1655/#14 |
| nvidia/nemotron-3-super-120b-a12b:free | 27.74 | high | flash | — (ниже flash-банда) | 0.0 | — |
| nvidia/nemotron-3-ultra-550b-a55b:free | 50.97 | high | flash | — (ниже flash-банда) | 0.0 | — |
| nvidia/nemotron-3.5-lightning:free | 21.24 | high | flash | — (ниже flash-банда) | 0.0 | — |
| qwen/qwen3.8-max-0902 | 90.94 | high | pro | mega | 3.0 | 1672/#10 |
| thinkingmachines/inkling-small:free | 52.87 | high | flash | — (ниже flash-банда) | 0.0 | — |
| upstage/solar-pro4 | 60.17 | high | pro | flash | 0.1575 | — |
| x-ai/grok-4.7 | 79.59 | medium | mega | pro | 3.0 | 1638/#15 |
| z-ai/glm-5.3-flash | 84.05 | high | flash | pro | 0.2375 | — |

## arena.ai Code Arena: модели из тиров на доске (Elo/место) (6)

| id | tiers | arena_code | votes |
|---|---|---|---|
| meta/muse-spark-1.3 | ['mega'] | 1656/#13 | 7678 |
| moonshotai/kimi-k3 | ['mega', 'pro'] | 1655/#14 | 17061 |
| qwen/qwen3.8-max-0902 | ['mega', 'pro'] | 1672/#10 | 3450 |
| x-ai/grok-4.7 | ['mega'] | 1638/#15 | 3734 |
| xiaomi/mimo-v2.6-flash | ['flash'] | 1636/#16 | 3851 |
| xiaomi/mimo-v2.6-pro | ['pro'] | 1630/#19 | 3415 |

## Устаревшие Go-маппинги (route id нет в каталоге Go) (0)

— нет

## Дубликаты между тирами (3)

| id | tiers |
|---|---|
| meta/muse-spark-1.3-contributor | ['pro', 'flash'] |
| moonshotai/kimi-k3 | ['mega', 'pro'] |
| qwen/qwen3.8-max-0902 | ['mega', 'pro'] |

## Не измерено (низкое покрытие метрик) (7)

| id | confidence | coverage | tiers |
|---|---|---|---|
| deepseek/deepseek-v4.1-flash | low | 0.15 | ['flash'] |
| meta/muse-spark-1.3-contributor | low | 0.0 | ['pro', 'flash'] |
| qwen/qwen3.8-flash | low | 0.0 | ['flash'] |
| xiaomi/mimo-v2.6-flash | low | 0.15 | ['flash'] |
| ~deepseek/deepseek-pro-latest | low | 0.0 | ['pro'] |
| ~z-ai/glm-flash-latest | low | 0.0 | ['flash'] |
| ~z-ai/glm-latest | low | 0.0 | ['pro'] |

## Пропало из каталога OpenRouter (1)

| id | tiers |
|---|---|
| stealth/space-bunny-alpha | ['flash'] |

## Сильные кандидаты вне тиров (score ≥ pro-порога) (10)

| id | score | confidence | blended_usd_per_m | is_free | arena_code |
|---|---|---|---|---|---|
| anthropic/claude-opus-5.5 | 98.71 | medium | 8.0 | False | 1814/#1 |
| anthropic/claude-fable-5.1 | 96.32 | high | 20.0 | False | 1745/#5 |
| anthropic/claude-sonnet-5.5 | 96.13 | medium | 4.0 | False | 1773/#3 |
| anthropic/claude-opus-5 | 92.95 | high | 10.0 | False | 1692/#7 |
| openai/gpt-6-astra | 91.82 | high | 20.0 | False | 1788/#2 |
| openai/gpt-6.1-sol | 91.17 | medium | 4.0 | False | 1757/#4 |
| google/gemini-4-argon | 89.83 | medium | 4.0 | False | 1678/#9 |
| openai/gpt-5.6-sol | 89.67 | high | 8.0 | False | — |
| anthropic/claude-fable-5 | 89.18 | high | 20.0 | False | — |
| openai/gpt-5.6-terra | 84.14 | high | 4.5 | False | — |

## Ёмкость Go не используется (в подписке, но не в modelMap) (25)

- `cat-jam-free`
- `claude-haiku-5-5`
- `deepseek-v4-pro`
- `gemini-4-argon-contributor`
- `glm-5.1`
- `glm-5.2`
- `gpt-5.6-luna`
- `gpt-6-luna`
- `hy3`
- `hy4-preview`
- `kimi-k2.6`
- `longcat-2.0`
- `longcat-2.5-preview-free`
- `mimo-v2.5`
- `mimo-v2.5-pro`
- `minimax-m2.5`
- `minimax-m2.7`
- `minimax-m3`
- `muse-spark-1.2-contributor`
- `omen-alpha`
- `qwen3.6-plus`
- `qwen3.7-max`
- `qwen3.7-plus`
- `space-bunny`
- `step-5-preview-free`

## Дрейф с прошлого снимка (|Δscore| ≥ 2 или цена ±20%) (0)

— нет
