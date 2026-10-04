# Estimation recipes

## Requests per second (QPS)
```text
QPS = daily active users × actions per user per day ÷ 86,400
peak QPS ≈ 2–5 × average
read:write ratio — usually reads ≫ writes (10:1 to 100:1)
```

## Storage
```text
storage/day  = new items per day × bytes per item
storage/year = storage/day × 365
× replication factor (often 3) × headroom (~1.3)
```

## Bandwidth
```text
bandwidth = QPS × bytes per response
e.g. 1,000 QPS × 100 KB = 100 MB/s ≈ 800 Mbit/s
```

## Servers needed
```text
servers ≈ peak QPS ÷ QPS one server handles
(a simple web server: ~1,000–10,000 QPS; a DB on one machine: ~1,000s–10,000s of simple queries/s)
```

## Cache size
```text
cache the hot set — often ~20% of daily read data (80/20 rule)
memory = hot items × bytes per item
```

## Tips
- Round hard: `86,400 → 100,000`, `365 → 400` if it helps
- Say assumptions out loud and write them down
- Sanity-check: does the answer fit on one machine? Then don't over-engineer
