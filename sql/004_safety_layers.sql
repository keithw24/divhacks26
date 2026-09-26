-- Extra public-safety layers (same lat/lon grain as complaints).
CREATE OR REPLACE FUNCTION nyc_meters(alat float8, alon float8, blat float8, blon float8)
RETURNS float8
LANGUAGE sql
IMMUTABLE
AS 'SELECT 6371000 * 2 * asin(sqrt(power(sin(radians(blat - alat) / 2), 2) + cos(radians(alat)) * cos(radians(blat)) * power(sin(radians(blon - alon) / 2), 2)))';

CREATE TABLE IF NOT EXISTS nypd_shootings (
    incident_key    text        NOT NULL,
    occurred_at     timestamptz NOT NULL,
    borough         text,
    precinct        smallint,
    loc_class       text,
    murder_flag     boolean,
    latitude        double precision,
    longitude       double precision,
    PRIMARY KEY (occurred_at, incident_key)
);

SELECT create_hypertable(
    'nypd_shootings', 'occurred_at',
    chunk_time_interval => INTERVAL '1 year',
    if_not_exists => TRUE
);

CREATE TABLE IF NOT EXISTS nyc_collisions (
    collision_id        text        NOT NULL,
    occurred_at         timestamptz NOT NULL,
    borough             text,
    on_street           text,
    off_street          text,
    persons_injured     integer,
    persons_killed      integer,
    ped_injured         integer,
    ped_killed          integer,
    cyc_injured         integer,
    cyc_killed          integer,
    latitude            double precision,
    longitude           double precision,
    PRIMARY KEY (occurred_at, collision_id)
);

SELECT create_hypertable(
    'nyc_collisions', 'occurred_at',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE
);

CREATE TABLE IF NOT EXISTS nyc_311_lights (
    unique_key      text        NOT NULL,
    occurred_at     timestamptz NOT NULL,
    complaint_type  text,
    descriptor      text,
    status          text,
    borough         text,
    latitude        double precision,
    longitude       double precision,
    PRIMARY KEY (occurred_at, unique_key)
);

SELECT create_hypertable(
    'nyc_311_lights', 'occurred_at',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS nypd_shootings_lat_lon_idx ON nypd_shootings (latitude, longitude);
CREATE INDEX IF NOT EXISTS nyc_collisions_lat_lon_idx ON nyc_collisions (latitude, longitude);
CREATE INDEX IF NOT EXISTS nyc_311_lights_lat_lon_idx ON nyc_311_lights (latitude, longitude);
