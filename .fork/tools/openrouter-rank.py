#!/usr/bin/env python3
"""Rank every OpenRouter model for coding work, from the public API.

Three independent metric sources are collected and kept separate, because they
measure different things and disagree:

  - Artificial Analysis indices (`benchmarks.artificial_analysis`) — absolute
    scores: `intelligence_index`, `coding_index`, `agentic_index`. The only
    source with a real coding score, and the sparsest: most models publish none.
  - Design Arena (`benchmarks.design_arena`) — pairwise-arena Elo per category,
    with `win_rate` and `rank`. Broad coverage, but Elo is relative to whoever
    else competed and is not comparable across categories.
  - Live endpoint statistics (`/models/{id}/endpoints`) — `uptime_last_1d`,
    `latency_last_30m`, `throughput_last_30m`, `quantization`, cache-read price.
    This is how a model behaves right now, not how good it is.

A model with no metrics is never dropped: it appears in `All Models` and
`No Metrics` with its gaps left visibly blank, so an unmeasured model reads as
unmeasured rather than as bad. Scoring happens only where a metric exists; the
`coverage` column states what fraction of the total score weight a model
actually supplied, so a high score over thin coverage is visible as exactly that.

Usage:
    python3 .fork/tools/openrouter-rank.py                    # catalog only (fast)
    python3 .fork/tools/openrouter-rank.py --perf             # + endpoint stats (458 req)
    python3 .fork/tools/openrouter-rank.py --perf --free-only # only :free models
    python3 .fork/tools/openrouter-rank.py --out DIR

Outputs into `.fork/reports/` by default:
    openrouter-coding-rank.xlsx   the workbook, one sheet per question
    openrouter-coding-rank.csv    the coding ranking alone, for diffs and grep
    openrouter-models.json        the raw catalog, so a rerun is comparable

No third-party HTTP client: `urllib` and `openpyxl` only. The catalog endpoint
needs no credential; the key is used when `OPENROUTER_API_KEY` happens to be
set, purely so a rate-limited account still gets its own limits rather than the
anonymous ones.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

API = "https://openrouter.ai/api/v1"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / ".fork" / "reports"

# Weights of the composite coding score. Each is applied only where the model
# reports that metric; the sum is then renormalized over the weights present, so
# a model missing Artificial Analysis is scored on arena and behaviour alone and
# its `coverage` column says so. `coding_index` dominates because it is the only
# metric that measures coding directly rather than by proxy.
WEIGHTS = {
    "coding_index": 0.40,
    "agentic_index": 0.20,
    "intelligence_index": 0.15,
    "arena_codecategories": 0.15,
    "arena_agentic_web": 0.10,
}

# Design Arena categories that describe building software, split in two groups so
# the composite does not count one measurement five times.
ARENA_CODE = ("codecategories", "fullstack", "gamedev")
ARENA_AGENTIC_WEB = ("website", "webapps", "uicomponent", "mobileapps", "androidnative")

# Every arena category the API publishes, in the order the workbook lists them.
ARENA_ALL = (
    "codecategories", "website", "gamedev", "uicomponent", "dataviz", "svg",
    "fullstack", "webapps", "mobileapps", "androidnative", "3d", "graphicdesign",
    "agenticgamedev", "agentichtmlslides", "agenticslides(html)",
    "agenticslides(python-pptx)", "agenticslides", "htmlslides", "pptxslides",
    "python-pptxslides", "godotgamedev", "image", "imageediting", "logo", "asciiart",
)


def api_get(path: str, api_key: str | None, timeout: int = 60) -> Any:
    """GET one API path, returning parsed JSON.

    Raises on transport and HTTP failures rather than returning a partial body: a
    ranking built from a truncated catalog would be wrong in a way nobody sees.
    """
    request = urllib.request.Request(f"{API}{path}", headers={"Accept": "application/json"})
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def as_float(value: Any) -> float | None:
    """A number, or `None` when the API gave nothing usable."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def per_million(price: Any) -> float | None:
    """A per-token price string as dollars per million tokens."""
    value = as_float(price)
    return None if value is None else round(value * 1_000_000, 4)


def variant_of(model_id: str) -> str:
    """The serving mode suffix of a model id, or `plain` for the ordinary one.

    `:batch`, `:free`, `:floor` and friends are modes of serving a model, not
    distinct models, so the ranking sheet marks them and the `--free-only` flag
    can select them without a second pass.
    """
    _, _, suffix = model_id.partition(":")
    return suffix or "plain"


def arena_of(model: dict[str, Any], category: str) -> float | None:
    """Elo in one Design Arena category, or `None` when the model did not compete."""
    for entry in (model.get("benchmarks") or {}).get("design_arena") or []:
        if entry.get("category") == category:
            return as_float(entry.get("elo"))
    return None


def arena_group_mean(model: dict[str, Any], categories: Iterable[str]) -> float | None:
    """Mean Elo across a group of categories, counting only the ones present."""
    present = [elo for elo in (arena_of(model, name) for name in categories) if elo is not None]
    return None if not present else statistics.fmean(present)


def normalize(values: list[float]) -> tuple[dict[float, float], float, float]:
    """Min-max scale the observed values into 0..100 for one metric.

    The scale comes from the models that report the metric, not from a fixed
    range: a metric nobody scores high on should not drag every model down. A
    metric whose values are all equal maps to 100, since nothing distinguishes
    those models on it.
    """
    low, high = min(values), max(values)
    if high == low:
        return {value: 100.0 for value in set(values)}, low, high
    return {value: (value - low) / (high - low) * 100.0 for value in set(values)}, low, high


def score(models: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, tuple[float, float]]]:
    """Attach every metric plus the composite score to each model.

    Returns the enriched rows and the observed range of each metric, so the
    workbook can state what the normalization ranged over.
    """
    rows: list[dict[str, Any]] = []
    for model in models:
        aaa = (model.get("benchmarks") or {}).get("artificial_analysis") or {}
        pricing = model.get("pricing") or {}
        architecture = model.get("architecture") or {}
        top = model.get("top_provider") or {}
        params = model.get("supported_parameters") or []
        reasoning = model.get("reasoning") or {}

        prompt = per_million(pricing.get("prompt"))
        completion = per_million(pricing.get("completion"))
        cache_read = per_million(pricing.get("input_cache_read"))
        # A 3:1 prompt:completion blend, the usual mix for agentic coding where
        # the transcript is resent far more often than it is extended.
        blended = None
        if prompt is not None and completion is not None:
            blended = round((3 * prompt + completion) / 4, 4)

        rows.append({
            # The raw catalog record: the Design Arena sheet reads any category
            # from it, so the ranking columns do not have to pre-compute all 25.
            "_source": model,
            "id": model.get("id"),
            "name": model.get("name"),
            "variant": variant_of(model.get("id") or ""),
            "canonical_slug": model.get("canonical_slug"),
            "knowledge_cutoff": model.get("knowledge_cutoff"),
            "context_window": as_float(model.get("context_length")),
            "max_output": as_float(top.get("max_completion_tokens")),
            "input_modalities": ",".join(architecture.get("input_modalities") or []),
            "output_modalities": ",".join(architecture.get("output_modalities") or []),
            "tokenizer": architecture.get("tokenizer"),
            "moderated": top.get("is_moderated"),
            "tools": "tools" in params,
            "structured_outputs": "structured_outputs" in params,
            "reasoning": "reasoning" in params or bool(reasoning),
            "reasoning_mandatory": reasoning.get("mandatory"),
            "reasoning_efforts": ",".join(reasoning.get("supported_efforts") or []),
            "web_search": "web_search_options" in params,
            "prompt_usd_per_m": prompt,
            "completion_usd_per_m": completion,
            "cache_read_usd_per_m": cache_read,
            "blended_usd_per_m": blended,
            "is_free": prompt == 0.0 and completion == 0.0,
            "intelligence_index": as_float(aaa.get("intelligence_index")),
            "coding_index": as_float(aaa.get("coding_index")),
            "agentic_index": as_float(aaa.get("agentic_index")),
            "arena_codecategories": arena_of(model, "codecategories"),
            "arena_fullstack": arena_of(model, "fullstack"),
            "arena_gamedev": arena_of(model, "gamedev"),
            "arena_website": arena_of(model, "website"),
            "arena_dataviz": arena_of(model, "dataviz"),
            "arena_uicomponent": arena_of(model, "uicomponent"),
            "arena_agentic_web": arena_group_mean(model, ARENA_AGENTIC_WEB),
            "arena_code_group": arena_group_mean(model, ARENA_CODE),
            "created": model.get("created"),
        })

    # One normalization per metric, computed over every model that reports it.
    ranges: dict[str, tuple[float, float]] = {}
    scaled: dict[str, dict[float, float]] = {}
    for metric in WEIGHTS:
        values = [row[metric] for row in rows if row.get(metric) is not None]
        if not values:
            continue
        table, low, high = normalize(values)
        scaled[metric] = table
        ranges[metric] = (low, high)

    for row in rows:
        total_weight = 0.0
        earned = 0.0
        for metric, weight in WEIGHTS.items():
            value = row.get(metric)
            if value is None or metric not in scaled:
                continue
            earned += scaled[metric][value] * weight
            total_weight += weight
        row["weight_present"] = round(total_weight, 4)
        row["coding_score"] = None if total_weight == 0 else round(earned / total_weight, 2)
        row["coverage"] = round(total_weight / sum(WEIGHTS.values()), 4)
        row["confidence"] = ("high" if row["coverage"] >= 0.75 else "medium" if row["coverage"] >= 0.40 else "low")
        row["metrics_present"] = sum(1 for m in WEIGHTS if row.get(m) is not None)
        blended = row["blended_usd_per_m"]
        row["score_per_dollar"] = (
            None if row["coding_score"] is None or not blended else round(row["coding_score"] / blended, 2)
        )
        row["has_any_benchmark"] = row["metrics_present"] > 0

    rows.sort(key=lambda r: (r["coding_score"] is None, -(r["coding_score"] or 0), r["id"] or ""))
    return rows, ranges


def fetch_endpoints(model_id: str, api_key: str | None) -> tuple[str, dict[str, Any]]:
    """Endpoint statistics for one model, flattened to the best-serving provider.

    `best` is the endpoint with the highest 1-day uptime, breaking ties on
    throughput, because a fast provider that is down is worth less than a slower
    one that answers.
    """
    try:
        body = api_get(f"/models/{model_id}/endpoints", api_key, timeout=30)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as failure:
        return model_id, {"perf_error": str(failure)[:120]}

    endpoints = (body.get("data") or {}).get("endpoints") or []
    usable = [e for e in endpoints if e.get("status") == 0]
    if not usable:
        return model_id, {"perf_providers": len(endpoints), "perf_usable": 0}

    def uptime(entry: dict[str, Any]) -> float:
        return as_float(entry.get("uptime_last_1d")) or 0.0

    def throughput(entry: dict[str, Any]) -> float:
        return as_float(entry.get("throughput_last_30m")) or 0.0

    best = max(usable, key=lambda e: (uptime(e), throughput(e)))
    price = best.get("pricing") or {}
    def pct(field: str) -> float | None:
        value = as_float(best.get(field))
        return None if value is None else round(value, 2)

    def num(field: str) -> float | None:
        value = as_float(best.get(field))
        return None if value is None else round(value, 2)

    return model_id, {
        "perf_providers": len(endpoints),
        "perf_usable": len(usable),
        "best_provider": best.get("provider_name"),
        "best_tag": best.get("tag"),
        "quantization": best.get("quantization"),
        "uptime_1d": pct("uptime_last_1d"),
        "uptime_30m": pct("uptime_last_30m"),
        "latency_ms": num("latency_last_30m"),
        "throughput_tps": num("throughput_last_30m"),
        "ep_context": as_float(best.get("context_length")),
        "ep_max_output": as_float(best.get("max_completion_tokens")),
        "ep_cache_read_usd_per_m": per_million(price.get("input_cache_read")),
        "ep_prompt_usd_per_m": per_million(price.get("prompt")),
        "ep_completion_usd_per_m": per_million(price.get("completion")),
        "tool_choice_required": (best.get("supports_tool_choice") or {}).get("required"),
        "implicit_caching": best.get("supports_implicit_caching"),
    }


def collect_perf(rows: list[dict[str, Any]], api_key: str | None, workers: int, every: int = 25) -> None:
    """Fetch and merge endpoint statistics for every model, in place.

    Each model is one request, so progress is printed: a silent two-minute wait
    over hundreds of requests reads as a hang.
    """
    ids = [row["id"] for row in rows if row.get("id")]
    print(f"  fetching endpoint stats for {len(ids)} models ({workers} workers)…", flush=True)
    by_id: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for done, (model_id, stats) in enumerate(pool.map(lambda m: fetch_endpoints(m, api_key), ids), 1):
            by_id[model_id] = stats
            if done % every == 0 or done == len(ids):
                print(f"    {done}/{len(ids)}", flush=True)
    for row in rows:
        row.update(by_id.get(row["id"], {}))


# Column order of the ranking sheets. Every metric a model may lack is adjacent
# to the score it feeds, so a blank cell is read next to the value it explains.
RANK_COLUMNS = [
    ("coding_score", "score", 10),
    ("confidence", "confidence", 11),
    ("coverage", "coverage", 10),
    ("metrics_present", "metrics", 9),
    ("id", "model", 46),
    ("variant", "variant", 9),
    ("coding_index", "coding_idx", 11),
    ("agentic_index", "agentic_idx", 12),
    ("intelligence_index", "intel_idx", 10),
    ("arena_codecategories", "arena_code", 11),
    ("arena_code_group", "arena_code_grp", 14),
    ("arena_agentic_web", "arena_agentic_web", 16),
    ("context_window", "ctx", 10),
    ("max_output", "max_out", 10),
    ("tools", "tools", 7),
    ("structured_outputs", "json", 7),
    ("reasoning", "reas", 7),
    ("blended_usd_per_m", "usd/M", 10),
    ("cache_read_usd_per_m", "cache/M", 10),
    ("score_per_dollar", "score/$", 10),
    ("is_free", "free", 7),
    ("best_provider", "provider", 16),
    ("uptime_1d", "uptime1d", 9),
    ("latency_ms", "latency", 9),
    ("throughput_tps", "tok/s", 9),
    ("quantization", "quant", 10),
]

ALL_COLUMNS = RANK_COLUMNS + [
    ("name", "name", 34),
    ("canonical_slug", "canonical", 34),
    ("knowledge_cutoff", "cutoff", 11),
    ("input_modalities", "input", 18),
    ("output_modalities", "output", 10),
    ("tokenizer", "tokenizer", 12),
    ("moderated", "moderated", 10),
    ("reasoning_efforts", "efforts", 22),
    ("arena_fullstack", "arena_fullstack", 14),
    ("arena_gamedev", "arena_gamedev", 14),
    ("arena_website", "arena_website", 13),
    ("arena_dataviz", "arena_dataviz", 13),
    ("arena_uicomponent", "arena_uicomp", 13),
    ("prompt_usd_per_m", "prompt/M", 10),
    ("completion_usd_per_m", "compl/M", 10),
    ("web_search", "websearch", 11),
    ("reasoning_mandatory", "reas_req", 10),
    ("perf_providers", "providers", 10),
    ("perf_usable", "providers_ok", 12),
    ("best_tag", "ep_tag", 22),
    ("ep_context", "ep_ctx", 9),
    ("ep_max_output", "ep_maxout", 10),
    ("ep_prompt_usd_per_m", "ep_prompt/M", 12),
    ("ep_completion_usd_per_m", "ep_compl/M", 12),
    ("ep_cache_read_usd_per_m", "ep_cache/M", 12),
    ("tool_choice_required", "tool_req", 10),
    ("implicit_caching", "implicit_cache", 14),
    ("created", "created", 11),
]


def write_sheet(worksheet: Any, rows: list[dict[str, Any]], columns: list[tuple[str, str, int]],
                header_fill: Any, header_font: Any, border: Any) -> None:
    """Fill one worksheet: a frozen header row, then the rows in the given order."""
    for index, (_, title, width) in enumerate(columns, 1):
        cell = worksheet.cell(row=1, column=index, value=title)
        cell.fill = header_fill
        cell.font = header_font
        cell.border = border
        worksheet.column_dimensions[cell.column_letter].width = width
    for row_index, row in enumerate(rows, 2):
        for column_index, (key, _, _) in enumerate(columns, 1):
            value = row.get(key)
            if isinstance(value, bool):
                value = "yes" if value else "no"
            worksheet.cell(row=row_index, column=column_index, value=value)
    worksheet.freeze_panes = "A2"
    if rows:
        worksheet.auto_filter.ref = (
            f"A1:{worksheet.cell(row=1, column=len(columns)).column_letter}{len(rows) + 1}"
        )


def build_workbook(rows: list[dict[str, Any]], ranges: dict[str, tuple[float, float]],
                   out_path: Path, catalog_meta: dict[str, Any], perf: bool) -> None:
    """Write the multi-sheet workbook, one sheet per question asked of the data."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    header_fill = PatternFill("solid", fgColor="1F3864")
    header_font = Font(bold=True, color="FFFFFF", size=10)
    side = Side(style="thin", color="BFBFBF")
    border = Border(left=side, right=side, top=side, bottom=side)
    note_font = Font(italic=True, size=9, color="595959")

    workbook = Workbook()

    def sheet(title: str, data: list[dict[str, Any]], columns: list[tuple[str, str, int]], note: str | None = None):
        worksheet = workbook.create_sheet(title)
        write_sheet(worksheet, data, columns, header_fill, header_font, border)
        if note is not None:
            cell = worksheet.cell(row=len(data) + 3, column=1, value=note)
            cell.font = note_font
            cell.alignment = Alignment(wrap_text=False)
        return worksheet

    measured = [row for row in rows if row["coding_score"] is not None]
    plain = [row for row in measured if row["variant"] == "plain"]

    # The sheet the question is asked of: ranked, with every gap left visible.
    sheet("Coding Ranking", measured, RANK_COLUMNS,
          "Ranked by composite coding score. `coverage` is the share of the score's total weight this model "
          "actually reported — a high score over low coverage rests on fewer metrics. Blank metrics are "
          "unpublished, not zero. Score normalizes each metric from 0 to 100 across the models that report it.")

    # Same ranking with serving modes (`:batch`, `:free`) removed: those are ways
    # of serving a model, and leaving them in makes one model look like several.
    sheet("Coding Ranking (plain)", plain, RANK_COLUMNS,
          "The same ranking with `:batch`, `:free` and other serving modes removed, one row per model.")

    free = [row for row in measured if row["is_free"]]
    sheet("Free Models", free, RANK_COLUMNS,
          "Models priced at zero in both directions. These are the `:free` variants: a 1000-request daily "
          "ceiling at 20 requests/minute, shared account-wide, when the account has purchased at least "
          "$10 of credits.")

    sheet("All Models", rows, ALL_COLUMNS,
          "Every model the catalog returned, scored or not, so an unmeasured model stays visible as unmeasured.")

    sheet("No Metrics", [row for row in rows if not row["has_any_benchmark"]], ALL_COLUMNS,
          "Models publishing neither an Artificial Analysis index nor a Design Arena Elo. Nothing here can be "
          "ranked on quality; the columns are what the API does state about them.")

    # Design Arena: Elo is per category and never comparable across them, so this
    # sheet is a pivot rather than a ranking.
    arena_rows: list[dict[str, Any]] = []
    for row in rows:
        if row["variant"] != "plain":
            continue
        entry: dict[str, Any] = {"id": row["id"], "context_window": row["context_window"],
                                 "blended_usd_per_m": row["blended_usd_per_m"]}
        for category in ARENA_ALL:
            entry[category] = arena_of(row["_source"], category)
        arena_rows.append(entry)
    arena_columns = [("id", "model", 46), ("context_window", "ctx", 10), ("blended_usd_per_m", "usd/M", 10)] + [
        (category, category, 14) for category in ARENA_ALL
    ]
    sheet("Design Arena", arena_rows, arena_columns,
          "Pairwise-arena Elo per category. Elo is relative to the models that competed in that category, so "
          "values are comparable down a column and not across one.")

    if perf:
        perf_columns = [
            ("coding_score", "score", 10),
            ("id", "model", 46),
            ("best_provider", "provider", 18),
            ("best_tag", "endpoint_tag", 26),
            ("quantization", "quant", 10),
            ("uptime_1d", "uptime1d", 9),
            ("uptime_30m", "uptime30m", 10),
            ("latency_ms", "latency_ms", 11),
            ("throughput_tps", "tok/s", 9),
            ("perf_providers", "providers", 10),
            ("perf_usable", "providers_ok", 12),
            ("ep_prompt_usd_per_m", "ep_prompt/M", 12),
            ("ep_completion_usd_per_m", "ep_compl/M", 12),
            ("ep_cache_read_usd_per_m", "ep_cache/M", 12),
            ("implicit_caching", "implicit_cache", 14),
            ("tool_choice_required", "tool_req", 10),
            ("ep_context", "ep_ctx", 9),
        ]
        sheet("Providers", [row for row in rows if row.get("best_provider") or row.get("perf_error")],
              perf_columns,
              "Live endpoint statistics, best-serving provider per model (highest 1-day uptime, then "
              "throughput). Latency and throughput are 30-minute windows and move.")

    # What each metric ranged over, so a normalized 0-100 is readable as a real value.
    meta_rows = []
    for metric, (low, high) in sorted(ranges.items()):
        meta_rows.append({"metric": metric, "weight": WEIGHTS[metric], "min_observed": low, "max_observed": high,
                          "models_reporting": sum(1 for row in rows if row.get(metric) is not None)})
    for key, value in catalog_meta.items():
        meta_rows.append({"metric": key, "weight": None, "min_observed": value, "max_observed": None,
                          "models_reporting": None})
    sheet("Method & Ranges", meta_rows, [
        ("metric", "field", 26), ("weight", "score weight", 13),
        ("min_observed", "min observed", 14), ("max_observed", "max observed", 14),
        ("models_reporting", "models reporting", 16),
    ], "The composite score is a weighted mean of min-max normalized metrics, renormalized over the weights a "
       "model actually reported. Weights: coding_index .40, agentic_index .20, intelligence_index .15, "
       "arena_codecategories .15, agentic web group .10.")

    del workbook["Sheet"]
    workbook.save(out_path)


def write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    """Write the ranking as CSV: diffable, greppable, no spreadsheet needed."""
    measured = [row for row in rows if row["coding_score"] is not None]
    keys = ["coding_score", "confidence", "coverage", "metrics_present", "id", "variant", "coding_index", "agentic_index",
            "intelligence_index", "arena_codecategories", "arena_code_group", "arena_agentic_web",
            "context_window", "max_output", "tools", "structured_outputs", "reasoning",
            "blended_usd_per_m", "cache_read_usd_per_m", "score_per_dollar", "is_free", "best_provider",
            "uptime_1d", "latency_ms", "throughput_tps", "quantization"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        for row in measured:
            writer.writerow({key: ("" if row.get(key) is None else row.get(key)) for key in keys})


def main() -> int:
    parser = argparse.ArgumentParser(description="Rank OpenRouter models for coding work.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    parser.add_argument("--perf", action="store_true", help="also fetch per-endpoint statistics (one request per model)")
    parser.add_argument("--free-only", action="store_true", help="fetch endpoint statistics for :free models only")
    parser.add_argument("--workers", type=int, default=8, help="parallel requests for --perf")
    parser.add_argument("--json", type=Path, default=None, help="where to keep the raw catalog")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    args.out.mkdir(parents=True, exist_ok=True)

    print("fetching model catalog…")
    catalog = api_get("/models", api_key)
    models = catalog.get("data") or []
    if not models:
        print("catalog returned no models", file=sys.stderr)
        return 1
    print(f"  {len(models)} models")

    rows, ranges = score(models)

    if args.perf:
        targets = rows if not args.free_only else [r for r in rows if r["is_free"]]
        collect_perf(targets, api_key, max(1, args.workers))

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    meta = {
        "generated": stamp,
        "models_in_catalog": len(models),
        "models_scored": sum(1 for r in rows if r["coding_score"] is not None),
        "models_unmeasured": sum(1 for r in rows if not r["has_any_benchmark"]),
        "endpoint_stats": "fetched" if args.perf else "not fetched",
    }

    json_path = args.json or args.out / "openrouter-models.json"
    json_path.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")

    xlsx_path = args.out / "openrouter-coding-rank.xlsx"
    build_workbook(rows, ranges, xlsx_path, meta, args.perf)
    csv_path = args.out / "openrouter-coding-rank.csv"
    write_csv(rows, csv_path)

    print(f"\n  scored {meta['models_scored']} of {len(models)} models"
          f" ({meta['models_unmeasured']} publish no benchmark at all)")
    print(f"  {xlsx_path}")
    print(f"  {csv_path}")
    print(f"  {json_path}")

    def show(title: str, subset: list[dict[str, Any]]) -> None:
        print(f"\n{title}:")
        for row in subset[:15]:
            price = "free" if row["is_free"] else f"${row['blended_usd_per_m']}/M"
            extra = f"  {row['coding_index']}" if row.get("coding_index") is not None else "   (no coding_idx)"
            print(f"  {row['coding_score']:6.2f}  cov={row['coverage']:.2f}  {row['id']:<46} {price}{extra}")

    show("top 15 by composite coding score", [r for r in rows if r["coding_score"] is not None])
    show("top 15 with HIGH confidence (coverage >= 0.75)",
         [r for r in rows if r["coding_score"] is not None and r["confidence"] == "high"])
    show("top 15 FREE models", [r for r in rows if r["coding_score"] is not None and r["is_free"]])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
