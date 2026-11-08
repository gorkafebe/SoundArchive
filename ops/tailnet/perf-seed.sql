-- Synthetic data for the performance check. Only for throwaway stacks.
INSERT INTO places (name, description, location)
SELECT 'perf ' || n, 'synthetic',
       ST_SetSRID(ST_MakePoint(-9 + random() * 12, 36 + random() * 7), 4326)::geography
FROM generate_series(1, 10000) AS n;

-- 2000 recordings: spread over places, with one place holding 200 of them.
WITH picked AS (
    SELECT id, row_number() OVER () AS n FROM places WHERE name LIKE 'perf %' LIMIT 1800
), one AS (SELECT id FROM places WHERE name LIKE 'perf %' LIMIT 1)
INSERT INTO recordings (place_id, title, recorded_at, status, capture_method, duration_seconds)
SELECT id, 'perf ' || n, now() - (n || ' hours')::interval, 'ready', 'upload', 60 FROM picked
UNION ALL
SELECT (SELECT id FROM one), 'perf x' || n, now() - (n || ' days')::interval, 'ready', 'upload', 60
FROM generate_series(1, 200) AS n;
ANALYZE places;
ANALYZE recordings;
