#!/usr/bin/env python3
"""Measure what fp4 costs versus fp8 on coding, by executing generated code.

General claims about quantization are cheap; this runs the same coding tasks
against the same model served at two precisions and grades the output by running
it. A task passes only if the generated function survives its edge cases, so a
model that merely looks right in prose scores zero.

Provider routing pins the quantization (`provider.quantizations`, `allow_fallbacks:
false`) so a run cannot silently drift to the other precision. When no endpoint
carries the requested quantization the run errors out instead of substituting.

Usage:
    OPENROUTER_API_KEY=... python3 .fork/tools/quant-ab-test.py
    ... --models qwen/qwen3.8-27b --tasks 4 --repeat 2

Generated code is executed in a subprocess with a timeout and no environment
inherited, so a bad answer fails its own test rather than affecting this host.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://openrouter.ai/api/v1/chat/completions"
REPO_ROOT = Path(__file__).resolve().parents[2]

# Each task names a function and the assertions its output must survive. The
# cases are chosen where sloppy generation fails: touching intervals, sign and
# exponent edges, in-place mutation, rectangular input.
TASKS = [
    {
        "name": "merge_intervals",
        "prompt": (
            "Write a Python function `merge_intervals(intervals: list[list[int]]) -> list[list[int]]` "
            "that merges overlapping intervals and returns them sorted by start. Touching intervals merge "
            "([1,2] and [2,3] -> [[1,3]]). Empty input returns []. Do not include any example usage, "
            "explanation, or tests — return only the function."
        ),
        "tests": """
assert merge_intervals([]) == []
assert merge_intervals([[1,3]]) == [[1,3]]
assert merge_intervals([[1,2],[2,3]]) == [[1,3]]
assert merge_intervals([[4,5],[1,2]]) == [[1,2],[4,5]]
assert merge_intervals([[1,10],[2,3],[4,5]]) == [[1,10]]
assert merge_intervals([[1,2]]) == [[1,2]]
assert merge_intervals([[5,6],[1,2],[2,3]]) == [[1,3],[5,6]]
assert merge_intervals([[1,4],[0,0]]) == [[0,0],[1,4]]
""",
    },
    {
        "name": "is_number",
        "prompt": (
            "Write a Python function `is_number(s: str) -> bool` that returns True iff `s`, after stripping "
            "outer whitespace, is a valid decimal number: optional sign, digits with optional decimal point, "
            "optional exponent (e/E with optional sign and digits). A bare '.' or a bare 'e' or '1e' is False. "
            "Do not include examples, explanation, or tests — return only the function."
        ),
        "tests": """
assert is_number("1") is True
assert is_number(" 1 ") is True
assert is_number("-1.5") is True
assert is_number("+2e10") is True
assert is_number(" -1e-5 ") is True
assert is_number(".5") is True
assert is_number("5.") is True
assert is_number(".") is False
assert is_number("e") is False
assert is_number("1e") is False
assert is_number("1e+") is False
assert is_number("abc") is False
assert is_number("1 2") is False
assert is_number("") is False
assert is_number("--1") is False
""",
    },
    {
        "name": "next_permutation",
        "prompt": (
            "Write a Python function `next_permutation(nums: list[int]) -> None` that rearranges nums in-place "
            "into the next lexicographically greater permutation, or into the lowest (sorted ascending) order "
            "if no greater permutation exists. It must mutate the argument and return None. "
            "Do not include examples, explanation, or tests — return only the function."
        ),
        "tests": """
a = [1,2,3]; next_permutation(a); assert a == [1,3,2], a
b = [3,2,1]; next_permutation(b); assert b == [1,2,3], b
c = [1,1,5]; next_permutation(c); assert c == [1,5,1], c
d = [1]; next_permutation(d); assert d == [1], d
e = []; next_permutation(e); assert e == [], e
f = [1,3,2]; next_permutation(f); assert f == [2,1,3], f
g = [2,3,1]; next_permutation(g); assert g == [3,1,2], g
assert next_permutation([1,2]) is None
""",
    },
    {
        "name": "spiral_order",
        "prompt": (
            "Write a Python function `spiral_order(matrix: list[list[int]]) -> list[int]` that returns the "
            "elements of a matrix in clockwise spiral order. Input may be empty, 1x1, 1xN, Nx1, or rectangular. "
            "Do not include examples, explanation, or tests — return only the function."
        ),
        "tests": """
assert spiral_order([]) == []
assert spiral_order([[1]]) == [1]
assert spiral_order([[1,2,3]]) == [1,2,3]
assert spiral_order([[1],[2],[3]]) == [1,2,3]
assert spiral_order([[1,2],[3,4]]) == [1,2,4,3]
assert spiral_order([[1,2,3],[4,5,6],[7,8,9]]) == [1,2,3,6,9,8,7,4,5]
assert spiral_order([[1,2,3,4],[5,6,7,8],[9,10,11,12]]) == [1,2,3,4,8,12,11,10,9,5,6,7]
""",
    },
    {
        "name": "fix_bug",
        "prompt": (
            "The function below is buggy: for `nums = [1,3,5]` and `target = 4` it returns -1 instead of 1. "
            "Return ONLY the corrected function, no explanation.\n\n"
            "def binary_search(nums, target):\n"
            "    lo, hi = 0, len(nums)\n"
            "    while lo < hi:\n"
            "        mid = (lo + hi) // 2\n"
            "        if nums[mid] == target:\n"
            "            return mid\n"
            "        elif nums[mid] < target:\n"
            "            lo = mid\n"
            "        else:\n"
            "            hi = mid\n"
            "    return -1\n"
        ),
        "tests": """
assert binary_search([1,3,5], 4) == -1
assert binary_search([1,3,5], 1) == 0
assert binary_search([1,3,5], 5) == 2
assert binary_search([1,3,5], 2) == -1
assert binary_search([], 1) == -1
assert binary_search([2], 2) == 0
assert binary_search([1,2,3,4,5], 4) == 3
assert binary_search([1,2,3,4,5], 6) == -1
""",
    },
    {
        "name": "parse_semver",
        "prompt": (
            "Write a Python function `parse_semver(v: str) -> tuple[int,int,int,str,str]` that parses a semantic "
            "version like '1.2.3-alpha+build.5' into (major, minor, patch, prerelease, build). prerelease and "
            "build are '' when absent. '1.2' means patch 0. Raise ValueError on input that is not a version. "
            "Do not include examples, explanation, or tests — return only the function."
        ),
        "tests": """
assert parse_semver("1.2.3") == (1,2,3,"","")
assert parse_semver("1.2.3-alpha") == (1,2,3,"alpha","")
assert parse_semver("1.2.3-alpha+build.5") == (1,2,3,"alpha","build.5")
assert parse_semver("1.2.3+b") == (1,2,3,"","b")
assert parse_semver("1.2") == (1,2,0,"","")
assert parse_semver("0.0.1") == (0,0,1,"","")
try:
    parse_semver("nope"); assert False, "expected ValueError"
except ValueError:
    pass
""",
    },
]


def call(model: str, prompt: str, quantizations: list[str], api_key: str, max_tokens: int) -> dict:
    """One completion pinned to the requested quantizations, or an error record."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        # Pin the precision and refuse fallback: a run that cannot get fp4 must
        # fail loudly rather than quietly grade an fp8 answer as fp4.
        "provider": {"quantizations": quantizations, "allow_fallbacks": False},
    }
    request = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as failure:
        detail = failure.read().decode(errors="replace")[:300]
        return {"error": f"HTTP {failure.code}: {detail}", "seconds": time.time() - started}
    except Exception as failure:  # transport failures are a data point, not a crash
        return {"error": str(failure)[:200], "seconds": time.time() - started}

    choice = (payload.get("choices") or [{}])[0]
    content = choice.get("message", {}).get("content") or ""
    return {
        "content": content,
        "provider": payload.get("provider"),
        "seconds": time.time() - started,
        "usage": payload.get("usage") or {},
    }


def extract_code(content: str) -> str:
    """The generated source: a fenced block when present, else the raw text."""
    fenced = re.findall(r"```(?:python)?\s*\n(.*?)```", content, re.DOTALL)
    return fenced[0].strip() if fenced else content.strip()


def grade(code: str, tests: str, timeout: int) -> tuple[bool, str]:
    """Run the generated function against its edge cases in an isolated process."""
    if not code:
        return False, "no code produced"
    # Empty environment and a timeout: the answer is graded, never trusted.
    program = f"{code}\n{tests}\nprint('PASS')\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as handle:
        handle.write(program)
        path = handle.name
    try:
        result = subprocess.run(
            [sys.executable, path],
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"PATH": os.environ.get("PATH", "/usr/bin")},
        )
    except subprocess.TimeoutExpired:
        return False, "timeout"
    finally:
        os.unlink(path)
    if result.returncode == 0 and "PASS" in result.stdout:
        return True, "ok"
    tail = (result.stderr or result.stdout or "").strip().splitlines()
    return False, (tail[-1][:120] if tail else "failed")


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure fp4 vs fp8 coding quality.")
    parser.add_argument("--models", nargs="+",
                        default=["qwen/qwen3.8-27b", "nvidia/nemotron-3-ultra-550b-a55b"])
    parser.add_argument("--max-tokens", type=int, default=1200)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / ".fork" / "reports")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("OPENROUTER_API_KEY is not set", file=sys.stderr)
        return 1

    groups = {
        "fp8": ["fp8"],
        "fp4": ["fp4", "nvfp4", "mxfp4", "int4"],
    }
    rows = []
    args.out.mkdir(parents=True, exist_ok=True)

    for model in args.models:
        for precision, quants in groups.items():
            passed = 0
            attempted = 0
            for task in TASKS:
                for attempt in range(args.repeat):
                    print(f"  {model:<34} {precision:<4} {task['name']:<18} ", end="", flush=True)
                    result = call(model, task["prompt"], quants, api_key, args.max_tokens)
                    if "error" in result:
                        print(f"ERROR {result['error'][:70]}")
                        rows.append({"model": model, "precision": precision, "task": task["name"],
                                     "attempt": attempt, "pass": None, "provider": None,
                                     "seconds": round(result["seconds"], 1), "note": result["error"][:120]})
                        continue
                    code = extract_code(result["content"])
                    ok, note = grade(code, task["tests"], args.timeout)
                    attempted += 1
                    passed += 1 if ok else 0
                    print(f"{'PASS' if ok else 'FAIL':<5} {result['seconds']:5.1f}s "
                          f"via {str(result.get('provider')):<16} {note if not ok else ''}")
                    rows.append({"model": model, "precision": precision, "task": task["name"],
                                 "attempt": attempt, "pass": ok, "provider": result.get("provider"),
                                 "seconds": round(result["seconds"], 1), "note": note,
                                 "output_tokens": (result.get("usage") or {}).get("completion_tokens")})
            print(f"    -> {precision}: {passed}/{attempted} passed\n")

    out_path = args.out / "quant-ab-results.json"
    out_path.write_text(json.dumps(rows, indent=1), encoding="utf-8")

    print("=== SUMMARY ===")
    print(f"{'model':<36}{'prec':<6}{'pass':>8}{'avg_s':>8}  {'providers seen'}")
    for model in args.models:
        for precision in groups:
            subset = [r for r in rows if r["model"] == model and r["precision"] == precision]
            ok = [r for r in subset if r["pass"] is True]
            done = [r for r in subset if r["pass"] is not None]
            if not done:
                print(f"{model:<36}{precision:<6}{'n/a':>8}")
                continue
            avg = sum(r["seconds"] for r in done) / len(done)
            providers = sorted({str(r["provider"]) for r in subset if r["provider"]})
            print(f"{model:<36}{precision:<6}{f'{len(ok)}/{len(done)}':>8}{avg:>8.1f}  {', '.join(providers)[:44]}")
    print(f"\n  {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
