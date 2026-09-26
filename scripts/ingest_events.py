#!/usr/bin/env python3
"""Load official upcoming NYC events into Tiger Data."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from urllib.parse import urlencode
from urllib.request import urlopen
from zoneinfo import ZoneInfo

import psycopg
from dotenv import load_dotenv

load_dotenv()

SODA_BASE = "https://data.cityofnewyork.us/resource"
NYC_TIMEZONE = ZoneInfo("America/New_York")
COORDINATES = re.compile(r"(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)")
UPSERT = """
INSERT INTO city_events (
  source, source_id, title, description, category, starts_at, ends_at,
  venue, borough, latitude, longitude, source_url, registration_url, raw, updated_at
) VALUES (
  %(source)s, %(source_id)s, %(title)s, %(description)s, %(category)s,
  %(starts_at)s, %(ends_at)s, %(venue)s, %(borough)s, %(latitude)s,
  %(longitude)s, %(source_url)s, %(registration_url)s, %(raw)s::jsonb, now()
)
ON CONFLICT (source, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  venue = EXCLUDED.venue,
  borough = EXCLUDED.borough,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  source_url = EXCLUDED.source_url,
  registration_url = EXCLUDED.registration_url,
  raw = EXCLUDED.raw,
  updated_at = now()
"""


def fetch(dataset: str, page_size: int = 5000, max_rows: int = 50000) -> list[dict]:
    records: list[dict] = []
    while len(records) < max_rows:
        query = urlencode({"$limit": str(page_size), "$offset": str(len(records))})
        with urlopen(f"{SODA_BASE}/{dataset}.json?{query}", timeout=60) as response:
            page = json.loads(response.read().decode("utf-8"))
        records.extend(page)
        if len(page) < page_size:
            break
    if len(records) >= max_rows:
        print(f"warning: {dataset} reached the {max_rows:,}-row ingestion cap", file=sys.stderr)
    return records


def timestamp(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=NYC_TIMEZONE)
    except ValueError:
        return None


def url_value(value: object) -> str | None:
    if isinstance(value, dict):
        value = value.get("url")
    text = str(value or "").strip()
    return text or None


def coordinates(value: object) -> tuple[float | None, float | None]:
    match = COORDINATES.search(str(value or ""))
    if not match:
        return None, None
    latitude, longitude = float(match.group(1)), float(match.group(2))
    if not (40.4 < latitude < 41.0 and -74.4 < longitude < -73.6):
        return None, None
    return latitude, longitude


def parks(record: dict) -> dict | None:
    start = timestamp(record.get("starttime"))
    title = str(record.get("title") or "").strip()
    if not start or not title or title.upper().startswith(("CANCELED:", "CANCELLED:")):
        return None
    latitude, longitude = coordinates(record.get("coordinates"))
    return {
        "source": "NYC Parks",
        "source_id": str(record.get("guid") or record.get(":id") or f"{title}:{start.isoformat()}"),
        "title": title,
        "description": record.get("description"),
        "category": record.get("categories"),
        "starts_at": start,
        "ends_at": timestamp(record.get("endtime")),
        "venue": record.get("parknames") or record.get("location"),
        "borough": None,
        "latitude": latitude,
        "longitude": longitude,
        "source_url": url_value(record.get("link")),
        "registration_url": url_value(record.get("registration_url")),
        "raw": json.dumps(record),
    }


def permitted(record: dict) -> dict | None:
    start = timestamp(record.get("start_date_time"))
    title = str(record.get("event_name") or "").strip()
    if not start or not title:
        return None
    latitude, longitude = coordinates(record.get("event_location"))
    return {
        "source": "NYC Permitted Events",
        "source_id": str(record.get("event_id") or f"{title}:{start.isoformat()}"),
        "title": title,
        "description": None,
        "category": record.get("event_type"),
        "starts_at": start,
        "ends_at": timestamp(record.get("end_date_time")),
        "venue": record.get("event_location"),
        "borough": record.get("event_borough"),
        "latitude": latitude,
        "longitude": longitude,
        "source_url": "https://data.cityofnewyork.us/d/tvpp-9vvx",
        "registration_url": None,
        "raw": json.dumps(record),
    }


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("Set DATABASE_URL in .env first.")
    datasets = [
        (os.environ.get("PARKS_EVENTS_DATASET", "w3wp-dpdi"), parks),
        (os.environ.get("PERMITTED_EVENTS_DATASET", "tvpp-9vvx"), permitted),
    ]
    written = 0
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            for dataset, mapper in datasets:
                records = fetch(dataset)
                rows = [row for record in records if (row := mapper(record)) is not None]
                if rows:
                    cursor.executemany(UPSERT, rows)
                    written += len(rows)
                print(f"{dataset}: fetched={len(records):,} normalized={len(rows):,}")
        connection.commit()
    print(f"done. upserted={written:,}")


if __name__ == "__main__":
    main()
