#!/usr/bin/env python3
"""Load shootings, collisions, and 311 light/signal requests into Tiger."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

import psycopg
from dotenv import load_dotenv

load_dotenv()

SODA_BASE = "https://data.cityofnewyork.us/resource"


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
        return int(float(value.replace(",", "")))
    except ValueError:
        return None


def parse_float(value: str | None) -> float | None:
    value = clean(value)
    if value is None:
        return None
    try:
        return float(value.replace(",", ""))
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


def parse_clock(clock: str | None):
    clock = clean(clock) or "00:00:00"
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(clock, fmt).time()
        except ValueError:
            continue
    return datetime.min.time()


def combine_dt(date_s: str | None, time_s: str | None) -> datetime | None:
    day = parse_date(date_s)
    if day is None:
        return None
    return datetime.combine(day, parse_clock(time_s), tzinfo=timezone.utc)


def fetch_page(dataset: str, offset: int, limit: int, extra: dict[str, str]) -> list[dict]:
    params = {"$limit": str(limit), "$offset": str(offset), **extra}
    url = f"{SODA_BASE}/{dataset}.json?{urlencode(params)}"
    try:
        with urlopen(url, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError) as exc:
        raise SystemExit(f"NYC Open Data {dataset} failed: {exc}") from exc


def ingest(
    cur,
    dataset: str,
    extra: dict[str, str],
    limit: int,
    page_size: int,
    mapper,
    insert_sql: str,
) -> tuple[int, int]:
    inserted = skipped = offset = 0
    while True:
        remaining = limit - (inserted + skipped) if limit > 0 else page_size
        if limit > 0 and remaining <= 0:
            break
        batch = page_size if limit <= 0 else min(page_size, remaining)
        page = fetch_page(dataset, offset, batch, extra)
        if not page:
            break
        rows = []
        for record in page:
            mapped = mapper(record)
            if mapped is None:
                skipped += 1
            else:
                rows.append(mapped)
        if rows:
            cur.executemany(insert_sql, rows)
            cur.connection.commit()
            inserted += len(rows)
        offset += len(page)
        print(f"  {dataset} fetched {offset:,} | inserted {inserted:,} | skipped {skipped:,}")
        if len(page) < batch:
            break
    return inserted, skipped


def map_shooting(record: dict) -> dict | None:
    occurred_at = combine_dt(record.get("occur_date"), record.get("occur_time"))
    key = clean(record.get("incident_key"))
    lat = parse_float(record.get("latitude"))
    lon = parse_float(record.get("longitude"))
    if occurred_at is None or key is None or lat is None or lon is None:
        return None
    if lat < 40.4 or lat > 41.0 or lon < -74.4 or lon > -73.6:
        return None
    flag = record.get("statistical_murder_flag")
    murder = flag is True or str(flag).lower() == "true"
    return {
        "incident_key": key,
        "occurred_at": occurred_at,
        "borough": clean(record.get("boro")),
        "precinct": parse_int(record.get("precinct")),
        "loc_class": clean(record.get("loc_classfctn_desc")),
        "murder_flag": murder,
        "latitude": lat,
        "longitude": lon,
    }


def map_collision(record: dict) -> dict | None:
    occurred_at = combine_dt(record.get("crash_date"), record.get("crash_time"))
    cid = clean(record.get("collision_id"))
    lat = parse_float(record.get("latitude"))
    lon = parse_float(record.get("longitude"))
    if occurred_at is None or cid is None or lat is None or lon is None:
        return None
    if lat < 40.4 or lat > 41.0 or lon < -74.4 or lon > -73.6:
        return None
    return {
        "collision_id": cid,
        "occurred_at": occurred_at,
        "borough": clean(record.get("borough")),
        "on_street": clean(record.get("on_street_name")),
        "off_street": clean(record.get("off_street_name")),
        "persons_injured": parse_int(record.get("number_of_persons_injured")) or 0,
        "persons_killed": parse_int(record.get("number_of_persons_killed")) or 0,
        "ped_injured": parse_int(record.get("number_of_pedestrians_injured")) or 0,
        "ped_killed": parse_int(record.get("number_of_pedestrians_killed")) or 0,
        "cyc_injured": parse_int(record.get("number_of_cyclist_injured")) or 0,
        "cyc_killed": parse_int(record.get("number_of_cyclist_killed")) or 0,
        "latitude": lat,
        "longitude": lon,
    }


def map_311(record: dict) -> dict | None:
    created = clean(record.get("created_date"))
    key = clean(record.get("unique_key"))
    lat = parse_float(record.get("latitude"))
    lon = parse_float(record.get("longitude"))
    if created is None or key is None or lat is None or lon is None:
        return None
    try:
        occurred_at = datetime.fromisoformat(created.replace("Z", "+00:00"))
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    if lat < 40.4 or lat > 41.0 or lon < -74.4 or lon > -73.6:
        return None
    return {
        "unique_key": key,
        "occurred_at": occurred_at,
        "complaint_type": clean(record.get("complaint_type")),
        "descriptor": clean(record.get("descriptor")),
        "status": clean(record.get("status")),
        "borough": clean(record.get("borough")),
        "latitude": lat,
        "longitude": lon,
    }


SHOOT_SQL = """
INSERT INTO nypd_shootings (
    incident_key, occurred_at, borough, precinct, loc_class, murder_flag, latitude, longitude
) VALUES (
    %(incident_key)s, %(occurred_at)s, %(borough)s, %(precinct)s, %(loc_class)s,
    %(murder_flag)s, %(latitude)s, %(longitude)s
) ON CONFLICT (occurred_at, incident_key) DO NOTHING
"""

COLLIDE_SQL = """
INSERT INTO nyc_collisions (
    collision_id, occurred_at, borough, on_street, off_street,
    persons_injured, persons_killed, ped_injured, ped_killed, cyc_injured, cyc_killed,
    latitude, longitude
) VALUES (
    %(collision_id)s, %(occurred_at)s, %(borough)s, %(on_street)s, %(off_street)s,
    %(persons_injured)s, %(persons_killed)s, %(ped_injured)s, %(ped_killed)s,
    %(cyc_injured)s, %(cyc_killed)s, %(latitude)s, %(longitude)s
) ON CONFLICT (occurred_at, collision_id) DO NOTHING
"""

LIGHTS_SQL = """
INSERT INTO nyc_311_lights (
    unique_key, occurred_at, complaint_type, descriptor, status, borough, latitude, longitude
) VALUES (
    %(unique_key)s, %(occurred_at)s, %(complaint_type)s, %(descriptor)s, %(status)s,
    %(borough)s, %(latitude)s, %(longitude)s
) ON CONFLICT (occurred_at, unique_key) DO NOTHING
"""


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("Set DATABASE_URL in .env")
    page_size = int(os.environ.get("PAGE_SIZE", "1000"))
    shoot_limit = int(os.environ.get("SHOOTING_LIMIT", "15000"))
    crash_limit = int(os.environ.get("COLLISION_LIMIT", "20000"))
    lights_limit = int(os.environ.get("LIGHTS_LIMIT", "15000"))

    schema_path = Path(__file__).resolve().parents[1] / "sql" / "004_safety_layers.sql"
    schema = schema_path.read_text(encoding="utf-8")
    with psycopg.connect(database_url) as conn:
        for stmt in schema.split(";"):
            piece = stmt.strip()
            if piece:
                conn.execute(piece)
        conn.commit()
        print("schema applied")
        with conn.cursor() as cur:
            print("shootings")
            ingest(
                cur,
                "833y-fsy8",
                {"$order": "occur_date DESC", "$where": "latitude IS NOT NULL"},
                shoot_limit,
                page_size,
                map_shooting,
                SHOOT_SQL,
            )
            print("collisions")
            ingest(
                cur,
                "h9gi-nx95",
                {"$order": "crash_date DESC", "$where": "latitude IS NOT NULL"},
                crash_limit,
                page_size,
                map_collision,
                COLLIDE_SQL,
            )
            print("311 lights/signals")
            ingest(
                cur,
                "erm2-nwe9",
                {
                    "$order": "created_date DESC",
                    "$where": (
                        "complaint_type in('Street Light Condition','Traffic Signal Condition')"
                        " AND latitude IS NOT NULL"
                    ),
                },
                lights_limit,
                page_size,
                map_311,
                LIGHTS_SQL,
            )
    print("done")


if __name__ == "__main__":
    main()
