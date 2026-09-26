-- Speed up block-radius lookups (points are already WGS84 lat/lon).
CREATE INDEX IF NOT EXISTS nypd_complaints_lat_lon_idx
  ON nypd_complaints (latitude, longitude);
