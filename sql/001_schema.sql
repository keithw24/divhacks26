-- NYPD complaints as a Timescale hypertable (time + neighborhood).
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS nypd_complaints (
    cmplnt_num          text        NOT NULL,
    occurred_at         timestamptz NOT NULL,
    reported_on         date,
    ended_at            timestamptz,
    borough             text,
    precinct            smallint,
    patrol_boro         text,
    offense             text,
    offense_code        smallint,
    pd_desc             text,
    law_category        text,
    completed           text,
    premises            text,
    loc_of_occur        text,
    latitude            double precision,
    longitude           double precision,
    susp_age_group      text,
    susp_race           text,
    susp_sex            text,
    vic_age_group       text,
    vic_race            text,
    vic_sex             text,
    PRIMARY KEY (occurred_at, cmplnt_num)
);

SELECT create_hypertable(
    'nypd_complaints',
    'occurred_at',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS nypd_complaints_borough_time_idx
    ON nypd_complaints (borough, occurred_at DESC);

CREATE INDEX IF NOT EXISTS nypd_complaints_offense_time_idx
    ON nypd_complaints (offense, occurred_at DESC);

CREATE INDEX IF NOT EXISTS nypd_complaints_precinct_time_idx
    ON nypd_complaints (precinct, occurred_at DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS nypd_daily_by_borough
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', occurred_at) AS day,
    borough,
    law_category,
    count(*) AS complaints
FROM nypd_complaints
GROUP BY 1, 2, 3
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'nypd_daily_by_borough',
    start_offset => INTERVAL '2 years',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);
