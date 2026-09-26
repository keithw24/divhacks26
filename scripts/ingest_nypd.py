#!/usr/bin/env python3
"""Load NYPD complaint records from NYC Open Data into Tiger / TimescaleDB."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen
import json

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


def fetch_page(dataset: str, offset: int, limit: int) -> list[dict]:
    params = urlencode(
        {
            "$limit": str(limit),
            "$offset": str(offset),
            "$order": "cmplnt_fr_dt DESC",
        }
    )
    url = f"{SODA_BASE}/{dataset}.json?{params}"
    try:
        with urlopen(url, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError) as exc:
        raise SystemExit(f"NYC Open Data request failed: {exc}") from exc


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("Set DATABASE_URL in .env (see .env.example).")

    dataset = os.environ.get("NYPD_DATASET", "5uac-w243")
    page_size = int(os.environ.get("PAGE_SIZE", "1000"))
    ingest_limit = int(os.environ.get("INGEST_LIMIT", "20000"))

    inserted = 0
    skipped = 0
    offset = 0

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            while True:
                remaining = ingest_limit - (inserted + skipped) if ingest_limit > 0 else page_size
                if ingest_limit > 0 and remaining <= 0:
                    break
                batch_size = page_size if ingest_limit <= 0 else min(page_size, remaining)
                page = fetch_page(dataset, offset, batch_size)
                if not page:
                    break
                rows = []
                for record in page:
                    mapped = row_from_api(record)
                    if mapped is None:
                        skipped += 1
                    else:
                        rows.append(mapped)
                if rows:
                    cur.executemany(INSERT_SQL, rows)
                    conn.commit()
                    inserted += len(rows)
                offset += len(page)
                print(f"fetched {offset:,} | inserted {inserted:,} | skipped {skipped:,}")
                if len(page) < batch_size:
                    break

    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute("CALL refresh_continuous_aggregate('nypd_daily_by_borough', NULL, NULL);")

    print(f"done. inserted={inserted:,} skipped={skipped:,} dataset={dataset}")


if __name__ == "__main__":
    main()
