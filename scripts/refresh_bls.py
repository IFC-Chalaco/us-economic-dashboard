#!/usr/bin/env python3
"""Fetch official BLS series and publish compact dashboard JSON."""

from __future__ import annotations

import hashlib
import csv
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from io import BytesIO
from io import StringIO
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "series.json"
SITE_DIR = Path(os.environ.get("ECONOMIC_DASHBOARD_DOCS", ROOT / "docs"))
OUTPUT_PATH = SITE_DIR / "data" / "economic_data.json"
META_PATH = SITE_DIR / "data" / "dashboard_meta.json"
API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
FRED_CSV_URL = (
    "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_ids}&cosd={start_date}"
)
FRED_SOURCE_URL = "https://fred.stlouisfed.org/"
SPF_MEAN_URL = (
    "https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/"
    "survey-of-professional-forecasters/historical-data/meanLevel.xlsx"
)
SPF_DISPERSION_URL = (
    "https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/"
    "survey-of-professional-forecasters/historical-data/Dispersion_1.xlsx"
)
SPF_SOURCE_URL = (
    "https://www.philadelphiafed.org/surveys-and-data/"
    "real-time-data-research/survey-of-professional-forecasters"
)
XLSX_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {
    "r": "http://schemas.openxmlformats.org/package/2006/relationships",
    "od": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def ssl_context():
    if os.environ.get("BLS_INSECURE_SKIP_VERIFY") == "1":
        return ssl._create_unverified_context()
    return None


def request_bytes(url: str, timeout: int = 25) -> bytes:
    if "fred.stlouisfed.org" in url:
        result = subprocess.run(
            ["curl", "-fsSL", "--max-time", str(timeout), url],
            check=False,
            capture_output=True,
        )
        if result.returncode == 0:
            return result.stdout
        raise RuntimeError(
            f"Official data request failed for {url}: curl exit {result.returncode}"
        )
    request = urllib.request.Request(url, headers={"User-Agent": "us-economic-dashboard/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=ssl_context()) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Official data request failed for {url}: {exc}") from exc


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
    try:
        with urllib.request.urlopen(request, timeout=60, context=ssl_context()) as response:
            body = json.load(response)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"BLS API request failed: {exc}") from exc

    if body.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError(f"BLS API error: {body.get('message', 'unknown error')}")
    return {entry["seriesID"]: entry for entry in body["Results"]["series"]}


def finalize_fred_series(definition: dict, observations: list[dict]) -> dict:
    observations.sort(key=lambda item: item["date"])
    for index, observation in enumerate(observations):
        previous = observations[index - 1]["value"] if index else None
        observation["change"] = (
            round(observation["value"] - previous, 4) if previous is not None else None
        )
        observation["pct_change"] = (
            round((observation["value"] / previous - 1) * 100, 4)
            if previous not in (None, 0)
            else None
        )

    result = dict(definition)
    result["kind"] = "fred"
    result["source"] = "Federal Reserve Economic Data (FRED)"
    result["source_url"] = f"https://fred.stlouisfed.org/series/{definition['id']}"
    result["observations"] = observations
    return result


def load_fred_bulk(definitions: list[dict], start_year: int) -> tuple[list[dict], list[dict]]:
    ids = [definition["id"] for definition in definitions]
    body = request_bytes(
        FRED_CSV_URL.format(
            series_ids=",".join(ids), start_date=f"{start_year}-01-01"
        ),
        timeout=90,
    )
    values_by_id = {series_id: [] for series_id in ids}

    csv_contents = []
    try:
        with ZipFile(BytesIO(body)) as archive:
            csv_contents = [
                archive.read(name).decode("utf-8-sig")
                for name in archive.namelist()
                if name.endswith(".csv")
            ]
    except Exception:
        csv_contents = [body.decode("utf-8-sig")]

    for content in csv_contents:
        for row in csv.DictReader(StringIO(content)):
            date = row.get("observation_date", "")
            if not date or int(date[:4]) < start_year:
                continue
            for series_id in ids:
                value = numeric(row.get(series_id))
                if value is not None:
                    values_by_id[series_id].append({"date": date, "value": value})

    series = []
    errors = []
    for definition in definitions:
        observations = values_by_id[definition["id"]]
        if observations:
            series.append(finalize_fred_series(definition, observations))
        else:
            errors.append(
                {"id": definition["id"], "error": "No observations returned by FRED"}
            )
    return series, errors


def xlsx_sheet_rows(workbook_bytes: bytes, sheet_name: str) -> list[dict]:
    with ZipFile(BytesIO(workbook_bytes)) as archive:
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        relationships = ElementTree.fromstring(
            archive.read("xl/_rels/workbook.xml.rels")
        )
        targets = {
            item.get("Id"): item.get("Target")
            for item in relationships.findall("r:Relationship", REL_NS)
        }
        sheet_target = None
        for sheet in workbook.findall(".//m:sheets/m:sheet", XLSX_NS):
            if sheet.get("name") == sheet_name:
                sheet_target = targets[sheet.get(f"{{{REL_NS['od']}}}id")]
                break
        if not sheet_target:
            raise RuntimeError(f"SPF workbook is missing the {sheet_name} sheet")

        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [
                "".join(node.text or "" for node in item.iterfind(".//m:t", XLSX_NS))
                for item in shared_root.findall("m:si", XLSX_NS)
            ]

        sheet_path = f"xl/{sheet_target.lstrip('/')}"
        sheet_root = ElementTree.fromstring(archive.read(sheet_path))
        rows = []
        for row in sheet_root.findall(".//m:sheetData/m:row", XLSX_NS):
            values = {}
            for cell in row.findall("m:c", XLSX_NS):
                ref = cell.get("r", "")
                column = "".join(char for char in ref if char.isalpha())
                value_node = cell.find("m:v", XLSX_NS)
                value = "" if value_node is None else value_node.text
                if cell.get("t") == "s" and value:
                    value = shared_strings[int(value)]
                values[column] = value
            rows.append(values)
    return rows


def numeric(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def shift_quarter(year: int, quarter: int, offset: int) -> tuple[int, int]:
    zero_based = year * 4 + quarter - 1 + offset
    return zero_based // 4, zero_based % 4 + 1


def quarter_date(year: int, quarter: int) -> str:
    return f"{year}-{(quarter - 1) * 3 + 1:02d}-01"


def load_spf_expectations() -> dict:
    mean_rows = xlsx_sheet_rows(request_bytes(SPF_MEAN_URL), "UNEMP")
    dispersion_rows = xlsx_sheet_rows(request_bytes(SPF_DISPERSION_URL), "UNEMP")
    mean = next((row for row in reversed(mean_rows) if numeric(row.get("A"))), None)
    dispersion = next(
        (row for row in reversed(dispersion_rows) if "Q" in row.get("A", "")), None
    )
    if not mean or not dispersion:
        raise RuntimeError("SPF workbooks contain no current unemployment forecast")

    year = int(numeric(mean["A"]))
    quarter = int(numeric(mean["B"]))
    survey_date = f"{year}Q{quarter}"
    if dispersion["A"] != survey_date:
        raise RuntimeError(
            f"SPF workbook dates do not match: {survey_date} vs {dispersion['A']}"
        )

    mean_columns = ["D", "E", "F", "G", "H"]
    percentile_columns = [("B", "C"), ("E", "F"), ("H", "I"), ("K", "L"), ("N", "O")]
    observations = []
    for horizon, (mean_column, percentile_pair) in enumerate(
        zip(mean_columns, percentile_columns)
    ):
        forecast_year, forecast_quarter = shift_quarter(year, quarter, horizon)
        expected = numeric(mean.get(mean_column))
        p25 = numeric(dispersion.get(percentile_pair[0]))
        p75 = numeric(dispersion.get(percentile_pair[1]))
        if expected is None or p25 is None or p75 is None:
            continue
        observations.append(
            {
                "date": quarter_date(forecast_year, forecast_quarter),
                "expected_mean": round(expected, 4),
                "p25": round(p25, 4),
                "p75": round(p75, 4),
            }
        )

    return {
        "survey_date": survey_date,
        "frequency": "Quarterly",
        "variable": "Civilian unemployment rate",
        "unit": "Percent",
        "range_definition": "25th to 75th percentile of professional forecasts",
        "source": "Federal Reserve Bank of Philadelphia Survey of Professional Forecasters",
        "source_url": SPF_SOURCE_URL,
        "observations": observations,
    }


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
        else:
            observation["monthly_change"] = (
                round(observation["value"] - previous, 2) if previous is not None else None
            )
            observation["yearly_change"] = (
                round((observation["value"] / prior_year - 1) * 100, 2)
                if prior_year not in (None, 0)
                else None
            )
        if definition["id"].startswith("CES") and definition["id"].endswith("000001"):
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

    fred_definitions = config.get("fred", [])
    fred_series = []
    fred_errors = []
    for category in ("inflation", "labor", "growth", "markets"):
        definitions = [
            definition
            for definition in fred_definitions
            if definition["category"] == category
        ]
        category_start_year = max(start_year, now.year - 5) if category == "markets" else start_year
        batches = [
            definitions[offset : offset + 7]
            for offset in range(0, min(len(definitions), 7), 7)
        ]
        if len(definitions) > 7:
            batches.extend([[definition] for definition in definitions[7:]])
        for batch_index, batch in enumerate(batches):
            try:
                category_series, category_errors = load_fred_bulk(
                    batch, category_start_year
                )
                fred_series.extend(category_series)
                fred_errors.extend(category_errors)
            except Exception as exc:
                fred_errors.append(
                    {
                        "id": f"FRED_{category.upper()}_{batch_index + 1}",
                        "error": str(exc),
                    }
                )

    payload = {
        "source": "U.S. Bureau of Labor Statistics Public Data API",
        "source_url": "https://www.bls.gov/developers/",
        "generated_at": now.isoformat(),
        "series": series,
        "fred_series": fred_series,
        "fred_errors": fred_errors,
        "expectations": {"unemployment": load_spf_expectations()},
    }
    previous = load_json(OUTPUT_PATH, {})
    changed = stable_hash(previous) != stable_hash(payload)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if changed:
        OUTPUT_PATH.write_text(
            json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
        )

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
        "fred_series_count": len(fred_series),
        "fred_errors": fred_errors,
        "source": payload["source"],
        "source_url": payload["source_url"],
        "cpi_release_schedule": "https://www.bls.gov/schedule/news_release/cpi.htm",
        "employment_release_schedule": "https://www.bls.gov/schedule/news_release/empsit.htm",
        "expectations_source": SPF_SOURCE_URL,
        "fred_source": FRED_SOURCE_URL,
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
