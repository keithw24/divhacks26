#!/usr/bin/env python3
"""Load official upcoming NYC events into Tiger Data."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
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


def soda_now() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S")


def fetch(dataset: str, extra: dict[str, str], page_size: int = 2000, max_rows: int = 8000) -> list[dict]:
    records: list[dict] = []
    while len(records) < max_rows:
        params = {"$limit": str(page_size), "$offset": str(len(records)), **extra}
        try:
            with urlopen(f"{SODA_BASE}/{dataset}.json?{urlencode(params)}", timeout=90) as response:
                page = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError) as exc:
            raise SystemExit(f"NYC Open Data {dataset} failed: {exc}") from exc
        if not isinstance(page, list):
            raise SystemExit(f"NYC Open Data {dataset} returned a non-list payload")
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
    if isinstance(value, dict):
        lat = value.get("latitude") or value.get("lat")
        lon = value.get("longitude") or value.get("lng") or value.get("lon")
        if lat is not None and lon is not None:
            try:
                latitude, longitude = float(lat), float(lon)
            except (TypeError, ValueError):
                return None, None
            if 40.4 < latitude < 41.0 and -74.4 < longitude < -73.6:
                return latitude, longitude
            return None, None
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
    if start < datetime.now(timezone.utc) - timedelta(hours=6):
        return None
    latitude, longitude = coordinates(record.get("coordinates"))
    if latitude is None or longitude is None:
        return None
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
    if start < datetime.now(timezone.utc) - timedelta(hours=6):
        return None
    latitude, longitude = coordinates(record.get("event_location"))
    if latitude is None or longitude is None:
        latitude, longitude = coordinates(record.get("latitude") or record.get("long"))
    if latitude is None or longitude is None:
        return None
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


def apply_schema(connection) -> None:
    root = Path(__file__).resolve().parents[1]
    schema = (root / "sql" / "004_city_events.sql").read_text(encoding="utf-8")
    for stmt in schema.split(";"):
        piece = stmt.strip()
        if piece:
            connection.execute(piece)
    connection.commit()


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("Set DATABASE_URL in .env first.")
    since = soda_now()
    datasets = [
        (
            os.environ.get("PARKS_EVENTS_DATASET", "w3wp-dpdi"),
            parks,
            {"$order": "starttime ASC", "$where": f"starttime >= '{since}'"},
        ),
        (
            os.environ.get("PERMITTED_EVENTS_DATASET", "tvpp-9vvx"),
            permitted,
            {"$order": "start_date_time ASC", "$where": f"start_date_time >= '{since}'"},
        ),
    ]
    written = 0
    with psycopg.connect(database_url) as connection:
        apply_schema(connection)
        print("schema applied")
        with connection.cursor() as cursor:
            for dataset, mapper, extra in datasets:
                records = fetch(dataset, extra)
                rows = [row for record in records if (row := mapper(record)) is not None]
                if rows:
                    cursor.executemany(UPSERT, rows)
                    written += len(rows)
                print(f"{dataset}: fetched={len(records):,} inserted={len(rows):,} skipped={len(records) - len(rows):,}")
        connection.commit()
    print(f"done. upserted={written:,}")


if __name__ == "__main__":
    main()
