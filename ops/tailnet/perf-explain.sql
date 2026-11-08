-- The two queries that grow with the data, as the API runs them.
SELECT count(*) FROM places;
SELECT count(*) FROM recordings;

EXPLAIN ANALYZE
SELECT id, name, ST_X(geometry(location)), ST_Y(geometry(location))
FROM places
WHERE geometry(location) && ST_MakeEnvelope(-4, 40, -3, 41, 4326) AND removed_at IS NULL
ORDER BY created_at DESC, id
LIMIT 1001;

EXPLAIN ANALYZE
SELECT r.*
FROM recordings r
WHERE r.place_id = (SELECT place_id FROM recordings GROUP BY place_id ORDER BY count(*) DESC LIMIT 1)
  AND r.status <> 'uploading'
ORDER BY r.recorded_at DESC;
