CREATE TABLE IF NOT EXISTS city_events (
    source          text        NOT NULL,
    source_id       text        NOT NULL,
    title           text        NOT NULL,
    description     text,
    category        text,
    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz,
    venue           text,
    borough         text,
    latitude        double precision,
    longitude       double precision,
    source_url      text,
    registration_url text,
    raw             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, source_id)
);

CREATE INDEX IF NOT EXISTS city_events_time_idx
    ON city_events (starts_at, ends_at);

CREATE INDEX IF NOT EXISTS city_events_geo_idx
    ON city_events (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS city_events_category_time_idx
    ON city_events (category, starts_at);
