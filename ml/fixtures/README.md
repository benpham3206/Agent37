All recordings in this directory are SYNTHETIC test fixtures, fabricated by hand.
They contain no real gameplay, bot accounts, or controller identities.

- `synthetic-v1`: historical schema, with unknown identity and server time.
- `synthetic-v2-unknown`: all three v2 row keys present with null values.
- `synthetic-v2-human`: invented bot and connection IDs, including a takeover
  and a safety override. Timing always comes from `timestamp_ms`.

Each session is also marked `synthetic: true` in its metadata, so the upstream
eligibility contract excludes these fixtures from real-data promotion.
