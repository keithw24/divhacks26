-- Quick checks after ingest.

SELECT count(*) AS rows, min(occurred_at), max(occurred_at)
FROM nypd_complaints;

SELECT borough, count(*) AS n
FROM nypd_complaints
GROUP BY borough
ORDER BY n DESC;

SELECT offense, count(*) AS n
FROM nypd_complaints
WHERE occurred_at >= now() - interval '90 days'
GROUP BY offense
ORDER BY n DESC
LIMIT 15;

SELECT day, borough, sum(complaints) AS complaints
FROM nypd_daily_by_borough
GROUP BY day, borough
ORDER BY day DESC, complaints DESC
LIMIT 50;
