-- Navigation hazards: extra 311 fields + current film-permit street holds.

ALTER TABLE nyc_311_lights
  ADD COLUMN IF NOT EXISTS street_name text;

CREATE TABLE IF NOT EXISTS nyc_film_permits (
    event_id        text        NOT NULL,
    start_at        timestamptz NOT NULL,
    end_at          timestamptz NOT NULL,
    event_type      text,
    category        text,
    parking_held    text,
    borough         text,
    zipcodes        text,
    PRIMARY KEY (event_id, start_at)
);

SELECT create_hypertable(
    'nyc_film_permits', 'start_at',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS nyc_film_permits_window_idx
  ON nyc_film_permits (start_at, end_at);
