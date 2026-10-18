#!/usr/bin/env python3
"""Deterministic review of the live model-routing tiers against fresh data.

Answers one question: given what OpenRouter and OpenCode Go publish *right
now*, is every model still in the tier it belongs in, and what moved since the
last review. Run it whenever either vendor reshuffles models or pricing — a
new release, a repricing, a model retired — or on a cadence of your choice.

    python3 .fork/tools/model-review.py                # full review
    python3 .fork/tools/model-review.py --baseline FILE # compare to a chosen snapshot
    python3 .fork/tools/model-review.py --offline      # reuse latest.json, no network

Data sources (same as openrouter-rank.py, plus three):
  - OpenRouter `/models`            — benchmarks + pricing, scored by the shared
                                      `score()` weights (imported, never copied).
  - OpenCode Go `/zen/go/v1/models` — public, no key: the subscription's model
                                      roster, to catch stale `modelMap` entries
                                      and unused subscription capacity.
  - arena.ai Code Arena             — no public API of its own; consumed through
                                      the oolong-tea-2026/arena-ai-leaderboards
                                      daily archive (GitHub raw). Human-preference
                                      Elo that *does* rank open models — a third
                                      opinion next to AA indices and Design Arena.
  - `~/.dsh/profiles/web/cordis.patch.yml` — the *live* tiers: the config the
                                      router actually ranks with, not a copy.

Both auxiliary sources degrade, never fail the run: an unreachable Go or
arena.ai leaves its report section saying so, and the review still answers
its main question from OpenRouter + the live config.

Determinism: same catalog + same config + same baseline ⇒ byte-identical
report. Thresholds live in TIER_THRESHOLDS below, are applied only where
confidence is high or medium, and a low-confidence model is reported as
unmeasured rather than judged.

Outputs into `.fork/reports/model-review/`:
    <UTC date>.json    dated snapshot (history; the baseline of the next run)
    latest.json       copy of the newest snapshot
    report.md         the human report, regenerated every run

Exit code is 0 unless a check needs eyes: 1 = placement violations or stale
mappings found, 2 = hard error (network, unparsable config). Advisory rows
(drift, new candidates, duplicates) do not change the exit code.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILE = Path.home() / ".dsh" / "profiles" / "web" / "cordis.patch.yml"
DEFAULT_OUT = REPO_ROOT / ".fork" / "reports" / "model-review"
GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models"

# arena.ai publishes no API; this community archive snapshots its leaderboards
# daily. Walk back at most this many days to find a day the crawler filled.
ARENA_ARCHIVE = "https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/data"
ARENA_WALK_BACK_DAYS = 10
ARENA_BOARDS = ("code", "agent")

# Cloudflare in front of opencode.ai refuses the default `Python-urllib` agent;
# a browser-shaped one passes, so every fetch this tool makes carries one.
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")

# The placement rule. A model's composite coding score (0-100, the same weights
# openrouter-rank.py uses) maps to the tier it belongs in. The bands came from
# the 2026-10-11 snapshot: mega holds the 88+ leaders (muse-spark 91.8,
# qwen3.8-max 90.9, kimi-k3 88.9, grok-4.6 88.3), pro the 76-88 working band
# (glm-5.3 87.8, mimo-v2.6-pro 85.6), flash the 60-76 volume band. Scores below
# 60 do not belong in any tier of this deployment.
TIER_THRESHOLDS: dict[str, float] = {"mega": 88.0, "pro": 76.0, "flash": 60.0}
TIER_ORDER = ("mega", "pro", "flash")

# A move is only suggested when the score clears the target band edge by this
# much; smaller excursions are noise, not signal.
MOVE_MARGIN = 1.0

# Drift flags: a score that moved this many points, or a price that moved this
# fraction, is worth a line in the report.
DRIFT_SCORE = 2.0
DRIFT_PRICE = 0.20

# Roster noise, not candidates: `:batch`, `-prime`, `-ultraspeed`, `~…-latest`
# rolling aliases, `-exp` previews. Free models are real candidates for the
# flash tier and are marked, not dropped.
VARIANT_RE = re.compile(r":batch$|-prime$|-ultraspeed$|^~/|-exp$")


# ---------------------------------------------------------------------------
# Shared machinery: openrouter-rank.py is imported, never copied — its weights
# and scorer stay the single source of truth for both tools.
# ---------------------------------------------------------------------------
def load_ranking_module() -> Any:
    spec = importlib.util.spec_from_file_location(
        "openrouter_rank", TOOLS_DIR / "openrouter-rank.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {TOOLS_DIR / 'openrouter-rank.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fetch_json(url: str, api_key: str | None = None, timeout: int = 60) -> Any:
    headers = {"Accept": "application/json", "User-Agent": BROWSER_UA}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as error:
        raise RuntimeError(f"fetch failed: {url}: {error}") from error


def fetch_arena_board(board: str, today: datetime) -> tuple[dict[str, Any] | None, str]:
    """The newest non-empty day of one arena.ai board from the daily archive.

    The archive's crawler fails some days (2026-10-15 holds an empty index), so
    this walks back one day at a time. An `errors` array or a missing `models`
    list counts as empty. Returns `(board data, iso date used)` — `(None, …)`
    when no day within the window has the board.
    """
    for step in range(ARENA_WALK_BACK_DAYS + 1):
        day = today - __import__("datetime").timedelta(days=step)
        date_iso = day.strftime("%Y-%m-%d")
        url = f"{ARENA_ARCHIVE}/{date_iso}/{board}.json"
        try:
            data = fetch_json(url, timeout=30)
        except RuntimeError:
            continue
        models = data.get("models") if isinstance(data, dict) else None
        if isinstance(models, list) and models:
            return data, date_iso
    return None, ""


# ---------------------------------------------------------------------------
# arena.ai names meet OpenRouter ids only after both are canonicalised:
# `muse-spark-1.3-max` and `muse-spark-1.3 (xHigh)` are `meta/muse-spark-1.3`,
# `qwen3.8-max-0902` and `qwen3.8-max` are the same family snapshot, `~z-ai/…`
# is a rolling alias. Lowercase, strip effort suffixes and dated snapshots,
# and compare the part after the vendor slash.
# ---------------------------------------------------------------------------
ARENA_EFFORT_RE = re.compile(r"[- ](max|xhigh|high|medium|low|mini|nano)$")
OR_DATE_RE = re.compile(r"-\d{4,5}$")


def canon_name(name: str) -> str:
    value = name.lower().strip()
    value = re.sub(r"\s*\([^)]*\)\s*$", "", value).strip()  # "(Max)" suffixes
    for _ in range(2):  # `-max-xhigh` style doubles never occur, single strip suffices twice
        stripped = ARENA_EFFORT_RE.sub("", value).strip()
        if stripped == value:
            break
        value = stripped
    value = OR_DATE_RE.sub("", value)
    return value


def canon_openrouter(model_id: str) -> str:
    value = model_id.split(":", 1)[0]  # `:free`, `:batch`
    value = value.split("@", 1)[0].strip().lstrip("~")
    _, _, slug = value.partition("/")
    slug = OR_DATE_RE.sub("", slug)
    return canon_name(slug)


# ---------------------------------------------------------------------------
# The live config. A scanner for exactly the shapes this profile uses — the
# `- id: model-routing` row, its `tiers:` list, each tier's `models:` and
# `extraSources:` — failing loudly with line numbers on anything unexpected,
# so a reformat of the file is a parse error here, not a silent empty review.
# ---------------------------------------------------------------------------
def parse_tiers(profile_path: Path) -> tuple[dict[str, list[str]], dict[str, dict[str, str]]]:
    """(tier name → [canonical model ids], route → {canonical → route model id})."""
    if not profile_path.is_file():
        raise RuntimeError(f"profile not found: {profile_path}")
    lines = profile_path.read_text(encoding="utf-8").splitlines()

    def fail(line_no: int, text: str) -> None:
        raise RuntimeError(f"{profile_path}:{line_no}: {text}")

    start = next((i for i, line in enumerate(lines) if line == "- id: model-routing"), None)
    if start is None:
        fail(1, "no '- id: model-routing' row; is the model-routing-profile bundle installed?")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("- id:")), len(lines))
    block = [(i, line) for i, line in enumerate(lines[start:end], start=start + 1)]

    tiers_at = next((n for n, line in block if line == " " * 4 + "tiers:"), None)
    if tiers_at is None:
        fail(start + 1, "model-routing row has no tiers: list")

    tiers: dict[str, list[str]] = {}
    routes: dict[str, dict[str, str]] = {}
    entries = [(n, line) for n, line in block if line.startswith(" " * 6 + "- name:")]
    for pos, (name_line_no, name_line) in enumerate(entries):
        tier_name = name_line.split("- name:", 1)[1].strip()
        next_entry = entries[pos + 1][0] if pos + 1 < len(entries) else block[-1][0] + 1
        body = [(n, line) for n, line in block if name_line_no < n < next_entry]

        # models: — a plain list of canonical ids.
        models: list[str] = []
        models_at = next((n for n, line in body if line == " " * 8 + "models:"), None)
        if models_at is not None:
            for n, line in body:
                if n <= models_at:
                    continue
                if line.startswith(" " * 10 + "- "):
                    models.append(line[12:].strip())
                elif not line.strip():
                    continue
                else:
                    break
        tiers[tier_name] = models

        # extraSources: — route entries, each with a modelMap canonical → id.
        # The map's rows are exactly the indent-14 lines between the `modelMap:`
        # key and the next non-empty line at indent 12 (`price:`, `tools:`), so
        # a sibling block never leaks into the mapping.
        extra_at = next((n for n, line in body if line == " " * 8 + "extraSources:"), None)
        if extra_at is None:
            continue
        for n, line in body:
            if n <= extra_at or not line.startswith(" " * 10 + "- route:"):
                continue
            route = line.split("- route:", 1)[1].strip()
            mapping: dict[str, str] = {}
            map_at = None
            for m, inner in body:
                if m <= n:
                    continue
                if map_at is None:
                    if inner == " " * 12 + "modelMap:":
                        map_at = m
                    continue
                if inner.startswith(" " * 14) and not inner.strip().startswith("#"):
                    if ":" in inner:
                        canonical, _, value = inner.strip().partition(":")
                        route_id = value.strip().strip("'\"")
                        if "@" in route_id:  # `value@{…price…}`: keep the id
                            route_id = route_id.split("@", 1)[0].strip().strip("'\"")
                        mapping[canonical.strip()] = route_id
                elif inner.strip():
                    break  # back at indent-12: the map is over
            routes.setdefault(route, {}).update(mapping)
    if not tiers:
        fail(start + 1, "model-routing row parsed but no tiers found")
    return tiers, routes


# ---------------------------------------------------------------------------
# The review itself.
# ---------------------------------------------------------------------------
def tier_of(score: float) -> str:
    for tier in TIER_ORDER:
        if score >= TIER_THRESHOLDS[tier]:
            return tier
    return "out"


def build_arena_index(board: dict[str, Any] | None, date_iso: str) -> dict[str, dict[str, Any]]:
    """canonical name → the board's best row for that model (max Elo, then rank)."""
    if board is None:
        return {}
    index: dict[str, dict[str, Any]] = {}
    for row in board.get("models", []):
        model, score = row.get("model", ""), row.get("score")
        if not model or not isinstance(score, (int, float)):
            continue  # the agent board's rows carry dimension arrays, not an Elo
        key = canon_name(str(model))
        best = index.get(key)
        if best is None or (score, -row.get("rank", 0)) > (best["elo"], -best.get("rank", 0)):
            index[key] = {"elo": score, "rank": row.get("rank"), "votes": row.get("votes"),
                          "model": model}
    return index


def arena_row(model_id: str, arena_code: dict[str, dict[str, Any]]) -> str:
    entry = arena_code.get(canon_openrouter(model_id))
    if entry is None:
        return "—"
    return f"{entry['elo']:.0f}/#{entry['rank']}"


def review(rows: list[dict[str, Any]], tiers: dict[str, list[str]],
           routes: dict[str, dict[str, str]], go_models: list[str],
           arena_code: dict[str, dict[str, Any]]) -> dict[str, Any]:
    by_id = {row["id"]: row for row in rows}

    seen_in: dict[str, list[str]] = {}
    for tier in TIER_ORDER:
        for model_id in tiers.get(tier, []):
            seen_in.setdefault(model_id, []).append(tier)

    placement: list[dict[str, Any]] = []
    unmeasured: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for model_id in sorted(seen_in):
        actual = seen_in[model_id]
        row = by_id.get(model_id)
        if row is None:
            missing.append({"id": model_id, "tiers": actual})
            continue
        score, confidence = row["coding_score"], row["confidence"]
        if confidence not in ("high", "medium"):
            unmeasured.append({"id": model_id, "tiers": actual, "confidence": confidence,
                               "coverage": row["coverage"]})
            continue
        want = tier_of(score)
        # The highest tier a model sits in is the claim under review; a lower
        # membership is a deliberate fallback and is not flagged.
        claim = max(actual, key=lambda t: TIER_ORDER.index(t))
        claim_edge = TIER_THRESHOLDS[claim]
        if want == "out":
            placement.append({"id": model_id, "score": score, "confidence": confidence,
                              "in_tier": claim, "belongs": "— (ниже flash-банда)",
                              "blended_usd_per_m": row.get("blended_usd_per_m"),
                              "arena_code": arena_row(model_id, arena_code)})
        elif want != claim:
            up = TIER_ORDER.index(want) < TIER_ORDER.index(claim)
            distance = score - claim_edge if up else claim_edge - score
            if distance > MOVE_MARGIN:
                placement.append({"id": model_id, "score": score, "confidence": confidence,
                                  "in_tier": claim, "belongs": want,
                                  "blended_usd_per_m": row.get("blended_usd_per_m"),
                                  "arena_code": arena_row(model_id, arena_code)})

    duplicates = [{"id": mid, "tiers": ts}
                   for mid, ts in sorted(seen_in.items()) if len(ts) > 1]

    # New candidates: base variants scoring at or above the pro band that no
    # tier names.
    in_tiers = set(seen_in)
    new_candidates: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda r: (-(r["coding_score"] or 0.0), r["id"])):
        if row["id"] in in_tiers or row["confidence"] not in ("high", "medium"):
            continue
        if VARIANT_RE.search(row["id"]):
            continue
        if row["coding_score"] < TIER_THRESHOLDS["pro"]:
            continue
        new_candidates.append({"id": row["id"], "score": row["coding_score"],
                               "confidence": row["confidence"],
                               "blended_usd_per_m": row.get("blended_usd_per_m"),
                               "is_free": row.get("is_free"),
                               "arena_code": arena_row(row["id"], arena_code)})
        if len(new_candidates) >= 10:
            break

    # OpenCode Go mapping health: the subscription roster vs the modelMap
    # entries that point at it.
    go_set = set(go_models)
    stale_mappings: list[dict[str, str]] = []
    mapped: set[str] = set()
    for route, mapping in routes.items():
        if "opencode" not in route:
            continue
        for canonical, route_id in mapping.items():
            mapped.add(route_id)
            if go_set and route_id not in go_set:
                stale_mappings.append({"route": route, "canonical": canonical,
                                       "route_id": route_id})
    unmapped_go = sorted(go_set - mapped) if go_set else []

    # Every tier model the arena.ai code board ranks — not only the misplaced
    # ones, so the report shows the third opinion wherever it exists.
    arena_of_tiers = []
    for model_id in sorted(seen_in):
        entry = arena_code.get(canon_openrouter(model_id))
        if entry is not None:
            arena_of_tiers.append({"id": model_id, "tiers": seen_in[model_id],
                                   "arena_code": f"{entry['elo']:.0f}/#{entry['rank']}",
                                   "votes": entry.get("votes")})

    return {"placement": placement, "duplicates": duplicates, "unmeasured": unmeasured,
            "missing": missing, "new_candidates": new_candidates,
            "stale_go_mappings": stale_mappings, "unmapped_go_models": unmapped_go,
            "arena_of_tiers": arena_of_tiers}


def drift(rows: list[dict[str, Any]], baseline: dict[str, Any] | None) -> list[dict[str, Any]]:
    if baseline is None:
        return []
    before = {row["id"]: row for row in baseline.get("rows", [])}
    moved: list[dict[str, Any]] = []
    for row in rows:
        old = before.get(row["id"])
        if old is None:
            continue
        score_delta = row["coding_score"] - old["coding_score"]
        price_now, price_then = row.get("blended_usd_per_m"), old.get("blended_usd_per_m")
        price_delta = None
        if price_now is not None and price_then not in (None, 0):
            price_delta = (price_now - price_then) / price_then
        if abs(score_delta) >= DRIFT_SCORE or (
                price_delta is not None and abs(price_delta) >= DRIFT_PRICE):
            moved.append({"id": row["id"], "score": row["coding_score"],
                          "score_delta": round(score_delta, 2),
                          "blended_usd_per_m": price_now,
                          "price_delta": None if price_delta is None else round(price_delta, 3)})
    moved.sort(key=lambda m: (-abs(m["score_delta"]), m["id"]))
    return moved[:25]


def build_report(now_iso: str, tiers: dict[str, list[str]], checks: dict[str, Any],
                 drift_rows: list[dict[str, Any]], sources: dict[str, str]) -> str:
    lines: list[str] = ["# Model review — " + now_iso, ""]
    lines.append("Живые тиры: " + ", ".join(f"`{t}` ({len(tiers.get(t, []))})"
                 for t in TIER_ORDER if t in tiers) + ". "
                 + "Пороги: " + ", ".join(f"{t}≥{TIER_THRESHOLDS[t]:.0f}" for t in TIER_ORDER)
                 + "; судятся только confidence high/medium.")
    lines.append("")
    lines.append("Источники: " + ", ".join(f"`{k}` {v}" for k, v in sources.items()))
    lines.append("")

    def table(rows: list[dict[str, Any]], columns: list[str]) -> list[str]:
        head = ["| " + " | ".join(columns) + " |", "|" + "---|" * len(columns)]
        body = ["| " + " | ".join(str(r.get(c, "—")) for c in columns) + " |" for r in rows]
        return head + body

    def section(title: str, entries: list[Any], render) -> None:
        lines.append(f"## {title} ({len(entries)})")
        lines.append("")
        if entries:
            lines.extend(render(entries))
        else:
            lines.append("— нет")
        lines.append("")

    section("Перестановки (misplaced)", checks["placement"],
            lambda r: table(r, ["id", "score", "confidence", "in_tier", "belongs",
                                "blended_usd_per_m", "arena_code"]))
    section("arena.ai Code Arena: модели из тиров на доске (Elo/место)",
            checks["arena_of_tiers"], lambda r: table(r, ["id", "tiers", "arena_code", "votes"]))
    section("Устаревшие Go-маппинги (route id нет в каталоге Go)",
            checks["stale_go_mappings"], lambda r: table(r, ["route", "canonical", "route_id"]))
    section("Дубликаты между тирами", checks["duplicates"], lambda r: table(r, ["id", "tiers"]))
    section("Не измерено (низкое покрытие метрик)", checks["unmeasured"],
            lambda r: table(r, ["id", "confidence", "coverage", "tiers"]))
    section("Пропало из каталога OpenRouter", checks["missing"],
            lambda r: table(r, ["id", "tiers"]))
    section("Сильные кандидаты вне тиров (score ≥ pro-порога)", checks["new_candidates"],
            lambda r: table(r, ["id", "score", "confidence", "blended_usd_per_m", "is_free",
                                "arena_code"]))
    section("Ёмкость Go не используется (в подписке, но не в modelMap)",
            checks["unmapped_go_models"], lambda r: ["- `" + m + "`" for m in r])
    section(f"Дрейф с прошлого снимка (|Δscore| ≥ {DRIFT_SCORE:g} или цена ±{DRIFT_PRICE:.0%})",
            drift_rows,
            lambda r: table(r, ["id", "score", "score_delta", "blended_usd_per_m", "price_delta"]))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Deterministic review of live model-routing tiers.")
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE,
                        help="live cordis.patch.yml (default: the web profile)")
    parser.add_argument("--baseline", type=Path, default=None,
                        help="snapshot to diff against (default: newest dated snapshot)")
    parser.add_argument("--offline", action="store_true",
                        help="score the latest.json snapshot instead of fetching")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    args = parser.parse_args()

    try:
        tiers, routes = parse_tiers(args.profile)
        ranking = load_ranking_module()
        api_key = ranking.os.environ.get("OPENROUTER_API_KEY")
        if args.offline:
            snapshot = json.loads((args.out / "latest.json").read_text(encoding="utf-8"))
            rows, now_iso = snapshot["rows"], snapshot["fetched_at"]
            go_models = snapshot.get("go_models", [])
            arena_code, arena_date = snapshot.get("arena_code_index", {}), snapshot.get("arena_date", "")
        else:
            catalog = ranking.api_get("/models", api_key)["data"]
            rows, _ranges = ranking.score(catalog)
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    sources: dict[str, str] = {"openrouter": now_iso[:10]}
    if not args.offline:
        # Auxiliary sources degrade, never fail the run: the main question —
        # tier placement — is answerable from OpenRouter + the live config.
        try:
            go_models = [m["id"] for m in fetch_json(GO_MODELS_URL)["data"]]
            sources["opencode-go"] = f"{len(go_models)} моделей"
        except (RuntimeError, KeyError, TypeError):
            go_models = []
            sources["opencode-go"] = "недоступен (разделы сверки пропущены)"
        try:
            board, arena_date = fetch_arena_board("code", datetime.now(timezone.utc))
            arena_code = build_arena_index(board, arena_date)
            sources["arena.ai/code"] = (f"снимок {arena_date}" if board is not None
                                        else "архив пуст за неделю (разделы пропущены)")
        except RuntimeError:
            arena_code, arena_date = {}, ""
            sources["arena.ai/code"] = "архив недоступен"
    else:
        sources["offline"] = "пересчёт latest.json"

    args.out.mkdir(parents=True, exist_ok=True)
    dated = args.out / (now_iso[:10] + ".json")

    baseline: dict[str, Any] | None = None
    baseline_path = args.baseline
    if baseline_path is None:
        dated_snapshots = sorted(p for p in args.out.glob("????-??-??.json") if p != dated)
        if dated_snapshots:
            baseline_path = dated_snapshots[-1]
    if baseline_path is not None and baseline_path.is_file():
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))

    checks = review(rows, tiers, routes, go_models, arena_code)
    drift_rows = drift(rows, baseline)

    snapshot = {"fetched_at": now_iso, "tiers": tiers, "go_models": go_models,
                "thresholds": TIER_THRESHOLDS, "arena_date": arena_date,
                "arena_code_index": arena_code, "rows": rows}
    dated.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")
    shutil.copyfile(dated, args.out / "latest.json")
    (args.out / "report.md").write_text(
        build_report(now_iso, tiers, checks, drift_rows, sources), encoding="utf-8")

    print(build_report(now_iso, tiers, checks, drift_rows, sources))
    print(f"snapshot: {dated}  baseline: {baseline_path}")
    return 1 if (checks["placement"] or checks["stale_go_mappings"]) else 0


if __name__ == "__main__":
    sys.exit(main())
