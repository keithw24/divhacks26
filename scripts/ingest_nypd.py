#!/usr/bin/env python3
"""Load NYPD complaint records from NYC Open Data into Tiger / TimescaleDB."""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

import psycopg
from dotenv import load_dotenv

load_dotenv()

SODA_BASE = "https://data.cityofnewyork.us/resource"
INSERT_SQL = """
INSERT INTO nypd_complaints (
    cmplnt_num, occurred_at, reported_on, ended_at, borough, precinct,
    patrol_boro, offense, offense_code, pd_desc, law_category, completed,
    premises, loc_of_occur, latitude, longitude,
    susp_age_group, susp_race, susp_sex, vic_age_group, vic_race, vic_sex
) VALUES (
    %(cmplnt_num)s, %(occurred_at)s, %(reported_on)s, %(ended_at)s, %(borough)s,
    %(precinct)s, %(patrol_boro)s, %(offense)s, %(offense_code)s, %(pd_desc)s,
    %(law_category)s, %(completed)s, %(premises)s, %(loc_of_occur)s,
    %(latitude)s, %(longitude)s, %(susp_age_group)s, %(susp_race)s, %(susp_sex)s,
    %(vic_age_group)s, %(vic_race)s, %(vic_sex)s
)
ON CONFLICT (occurred_at, cmplnt_num) DO NOTHING
"""


def clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    if value in ("", "(null)", "NULL"):
        return None
    return value


def parse_int(value: str | None) -> int | None:
    value = clean(value)
    if value is None:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def parse_float(value: str | None) -> float | None:
    value = clean(value)
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_date(value: str | None):
    value = clean(value)
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def combine_dt(date_s: str | None, time_s: str | None) -> datetime | None:
    day = parse_date(date_s)
    if day is None:
        return None
    clock = clean(time_s) or "00:00:00"
    try:
        t = datetime.strptime(clock, "%H:%M:%S").time()
    except ValueError:
        t = datetime.min.time()
    return datetime.combine(day, t, tzinfo=timezone.utc)


def row_from_api(record: dict) -> dict | None:
    occurred_at = combine_dt(record.get("cmplnt_fr_dt"), record.get("cmplnt_fr_tm"))
    cmplnt_num = clean(record.get("cmplnt_num"))
    if occurred_at is None or cmplnt_num is None:
        return None
    return {
        "cmplnt_num": cmplnt_num,
        "occurred_at": occurred_at,
        "reported_on": parse_date(record.get("rpt_dt")),
        "ended_at": combine_dt(record.get("cmplnt_to_dt"), record.get("cmplnt_to_tm")),
        "borough": clean(record.get("boro_nm")),
        "precinct": parse_int(record.get("addr_pct_cd")),
        "patrol_boro": clean(record.get("patrol_boro")),
        "offense": clean(record.get("ofns_desc")),
        "offense_code": parse_int(record.get("ky_cd")),
        "pd_desc": clean(record.get("pd_desc")),
        "law_category": clean(record.get("law_cat_cd")),
        "completed": clean(record.get("crm_atpt_cptd_cd")),
        "premises": clean(record.get("prem_typ_desc")),
        "loc_of_occur": clean(record.get("loc_of_occur_desc")),
        "latitude": parse_float(record.get("latitude")),
        "longitude": parse_float(record.get("longitude")),
        "susp_age_group": clean(record.get("susp_age_group")),
        "susp_race": clean(record.get("susp_race")),
        "susp_sex": clean(record.get("susp_sex")),
        "vic_age_group": clean(record.get("vic_age_group")),
        "vic_race": clean(record.get("vic_race")),
        "vic_sex": clean(record.get("vic_sex")),
    }


def lookback_start(now: datetime, years: float) -> datetime:
    return now - timedelta(days=365.25 * years)


def soda_since_clause(since: datetime) -> str:
    return f"cmplnt_fr_dt >= '{since.strftime('%Y-%m-%dT00:00:00')}'"


def nypd_datasets(years: float) -> list[str]:
    listed = os.environ.get("NYPD_DATASETS")
    if listed:
        return [item.strip() for item in listed.split(",") if item.strip()]
    if years > 0:
        # Historic covers the 2-year window; YTD fills months the historic feed still lags.
        return ["qgea-i56i", "5uac-w243"]
    return [os.environ.get("NYPD_DATASET", "5uac-w243")]


def fetch_page(dataset: str, offset: int, limit: int, extra: dict[str, str] | None = None) -> list[dict]:
    params = {
        "$limit": str(limit),
        "$offset": str(offset),
        "$order": "cmplnt_fr_dt ASC,cmplnt_num ASC",
        **(extra or {}),
    }
    url = f"{SODA_BASE}/{dataset}.json?{urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(6):
        try:
            with urlopen(url, timeout=90) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if not isinstance(payload, list):
                raise SystemExit(f"NYC Open Data {dataset} returned a non-list payload")
            return payload
        except (HTTPError, URLError) as exc:
            last_error = exc
            code = getattr(exc, "code", None)
            if code in {429, 500, 502, 503} and attempt < 5:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"NYC Open Data {dataset} failed: {exc}") from exc
    raise SystemExit(f"NYC Open Data {dataset} failed: {last_error}")


def ingest_dataset(
    cur,
    conn,
    dataset: str,
    *,
    page_size: int,
    ingest_limit: int,
    since: datetime | None,
) -> tuple[int, int]:
    inserted = 0
    skipped = 0
    offset = 0
    extra = {"$where": soda_since_clause(since)} if since else {}
    while True:
        seen = inserted + skipped
        if ingest_limit > 0 and seen >= ingest_limit:
            break
        remaining = ingest_limit - seen if ingest_limit > 0 else page_size
        batch_size = page_size if ingest_limit <= 0 else min(page_size, remaining)
        page = fetch_page(dataset, offset, batch_size, extra)
        if not page:
            break
        rows = []
        for record in page:
            mapped = row_from_api(record)
            if mapped is None:
                skipped += 1
                continue
            if since and mapped["occurred_at"] < since:
                skipped += 1
                continue
            rows.append(mapped)
        if rows:
            cur.executemany(INSERT_SQL, rows)
            conn.commit()
            inserted += len(rows)
        offset += len(page)
        print(f"{dataset}: fetched {offset:,} | inserted {inserted:,} | skipped {skipped:,}")
        if len(page) < batch_size:
            break
    return inserted, skipped


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("Set DATABASE_URL in .env (see .env.example).")

    years = float(os.environ.get("INGEST_YEARS") or "0")
    limit_raw = os.environ.get("INGEST_LIMIT")
    if limit_raw is None or limit_raw.strip() == "":
        ingest_limit = 0 if years > 0 else 20000
    else:
        ingest_limit = int(limit_raw)
    if years >= 2 and 0 < ingest_limit <= 20000:
        print(
            f"warning: INGEST_LIMIT={ingest_limit} is too small for a 2-year window; "
            "set INGEST_LIMIT=0 to load every matching complaint",
            file=sys.stderr,
        )
    page_size = int(os.environ.get("PAGE_SIZE", "5000" if years > 0 else "1000"))
    since = lookback_start(datetime.now(timezone.utc), years) if years > 0 else None
    datasets = nypd_datasets(years)

    if since:
        print(
            f"loading NYPD complaints since {since.date().isoformat()} "
            f"({years:g}y) from {', '.join(datasets)}"
            + (f", cap {ingest_limit:,}" if ingest_limit > 0 else ", no row cap")
        )
    else:
        print(f"loading {datasets[0]} (no year window, limit={ingest_limit})")

    inserted = 0
    skipped = 0
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            remaining_limit = ingest_limit
            for dataset in datasets:
                got, miss = ingest_dataset(
                    cur,
                    conn,
                    dataset,
                    page_size=page_size,
                    ingest_limit=remaining_limit if ingest_limit > 0 else 0,
                    since=since,
                )
                inserted += got
                skipped += miss
                if ingest_limit > 0:
                    remaining_limit = max(0, ingest_limit - (inserted + skipped))
                    if remaining_limit <= 0:
                        break

    with psycopg.connect(database_url, autocommit=True) as conn:
        try:
            conn.execute("CALL refresh_continuous_aggregate('nypd_daily_by_borough', NULL, NULL);")
        except psycopg.errors.LockNotAvailable:
            print("warning: daily aggregate already refreshing; hourly policy will finish it")

    print(f"done. inserted={inserted:,} skipped={skipped:,} datasets={','.join(datasets)}")


if __name__ == "__main__":
    main()
