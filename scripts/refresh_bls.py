#!/usr/bin/env python3
"""Fetch official BLS series and publish compact dashboard JSON."""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "series.json"
SITE_DIR = Path(os.environ.get("ECONOMIC_DASHBOARD_DOCS", ROOT / "docs"))
OUTPUT_PATH = SITE_DIR / "data" / "economic_data.json"
META_PATH = SITE_DIR / "data" / "dashboard_meta.json"
API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/"


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def request_series(series_ids: list[str], start_year: int, end_year: int) -> dict:
    payload = {
        "seriesid": series_ids,
        "startyear": str(start_year),
        "endyear": str(end_year),
        "calculations": True,
        "annualaverage": False,
    }
    api_key = os.environ.get("BLS_API_KEY", "").strip()
    if api_key:
        payload["registrationkey"] = api_key

    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "us-economic-dashboard/1.0"},
        method="POST",
    )
    ssl_context = None
    if os.environ.get("BLS_INSECURE_SKIP_VERIFY") == "1":
        ssl_context = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(request, timeout=60, context=ssl_context) as response:
            body = json.load(response)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"BLS API request failed: {exc}") from exc

    if body.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError(f"BLS API error: {body.get('message', 'unknown error')}")
    return {entry["seriesID"]: entry for entry in body["Results"]["series"]}


def period_date(year: str, period: str) -> str | None:
    if not period.startswith("M") or period == "M13":
        return None
    return f"{year}-{int(period[1:]):02d}-01"


def normalize_series(raw: dict, definition: dict, kind: str) -> dict:
    observations = []
    for row in raw.get("data", []):
        date = period_date(row["year"], row["period"])
        if not date:
            continue
        value_text = row.get("value", "").replace(",", "").strip()
        try:
            value = float(value_text)
        except ValueError:
            continue
        observations.append(
            {
                "date": date,
                "value": value,
                "footnotes": [note.get("text") for note in row.get("footnotes", []) if note.get("text")],
            }
        )
    observations.sort(key=lambda item: item["date"])

    for index, observation in enumerate(observations):
        previous = observations[index - 1]["value"] if index else None
        prior_year = observations[index - 12]["value"] if index >= 12 else None
        if kind == "cpi":
            observation["monthly_change"] = (
                round((observation["value"] / previous - 1) * 100, 2) if previous else None
            )
            observation["yearly_change"] = (
                round((observation["value"] / prior_year - 1) * 100, 2) if prior_year else None
            )
        elif definition["id"] == "CES0000000001":
            observation["monthly_change"] = round(observation["value"] - previous, 1) if previous else None

    result = dict(definition)
    result["kind"] = kind
    result["observations"] = observations
    return result


def stable_hash(payload: dict) -> str:
    clean = dict(payload)
    clean.pop("generated_at", None)
    return hashlib.sha256(
        json.dumps(clean, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def main() -> int:
    config = load_json(CONFIG_PATH, {})
    definitions = config.get("cpi", []) + config.get("labor", [])
    if not definitions:
        raise RuntimeError("No BLS series configured")

    now = datetime.now(timezone.utc)
    # The unregistered BLS API permits a maximum 10-year inclusive window.
    start_year = now.year - 9
    raw_by_id = {}
    ids = [item["id"] for item in definitions]
    for offset in range(0, len(ids), 20):
        raw_by_id.update(request_series(ids[offset : offset + 20], start_year, now.year))

    series = []
    for definition in config["cpi"]:
        series.append(normalize_series(raw_by_id.get(definition["id"], {}), definition, "cpi"))
    for definition in config["labor"]:
        series.append(normalize_series(raw_by_id.get(definition["id"], {}), definition, "labor"))

    payload = {
        "source": "U.S. Bureau of Labor Statistics Public Data API",
        "source_url": "https://www.bls.gov/developers/",
        "generated_at": now.isoformat(),
        "series": series,
    }
    previous = load_json(OUTPUT_PATH, {})
    changed = stable_hash(previous) != stable_hash(payload)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if changed:
        OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    latest_dates = {
        item["id"]: item["observations"][-1]["date"]
        for item in series
        if item["observations"]
    }
    meta = {
        "generated_at": now.isoformat(),
        "data_changed": changed,
        "latest_observations": latest_dates,
        "series_count": len(series),
        "source": payload["source"],
        "source_url": payload["source_url"],
        "cpi_release_schedule": "https://www.bls.gov/schedule/news_release/cpi.htm",
        "employment_release_schedule": "https://www.bls.gov/schedule/news_release/empsit.htm",
    }
    if changed or not META_PATH.exists():
        META_PATH.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"{'Updated' if changed else 'Checked'} {len(series)} BLS series.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
