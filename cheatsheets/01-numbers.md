# Numbers to know

## Latency ladder (rough, 2020s hardware)
```text
L1 cache reference ............ 1 ns
L2 cache reference ............ 4 ns
Main memory (RAM) ............. 100 ns
Read 1 MB from RAM ............ ~10 µs
SSD random read ............... ~100 µs
Read 1 MB from SSD ............ ~0.3–1 ms
Round trip in a datacenter .... ~0.5 ms
HDD seek ...................... ~10 ms
Round trip US ↔ Europe ........ ~80–150 ms
```
`1 ms = 1,000 µs = 1,000,000 ns`. RAM is ~1,000× faster than SSD random reads; the network to another continent is ~1,000,000× slower than RAM.

## Powers of two
```text
2^10 = 1,024          ≈ 1 thousand  (KB)
2^20 = 1,048,576      ≈ 1 million   (MB)
2^30                  ≈ 1 billion   (GB)
2^32 = 4,294,967,296  ≈ 4 billion   (max unsigned 32-bit)
2^40                  ≈ 1 trillion  (TB)
2^53                  ≈ 9 × 10^15   (Number.MAX_SAFE_INTEGER + 1)
2^64                  ≈ 1.8 × 10^19
```

## Time
```text
1 day   = 86,400 s   ≈ 10^5 s
1 month ≈ 2.6 million s ≈ 2.5 × 10^6
1 year  ≈ 31.5 million s ≈ 3 × 10^7
```
`N per day ÷ 10^5 ≈ per second`. 1 million/day ≈ 12/s. 1 billion/day ≈ 12,000/s.

## Sizes
```text
char (ASCII) ........ 1 B      UUID ............ 16 B (36 as text)
int / float ......... 4–8 B    tweet text ...... ~300 B
timestamp ........... 8 B      photo ........... 2–5 MB
short JSON record ... ~1 KB    1 min HD video .. ~50–100 MB
```

## Availability (nines)
```text
99%      → 3.65 days down per year
99.9%    → 8.8 hours per year   (43 min/month)
99.99%   → 53 minutes per year
99.999%  → 5.3 minutes per year
```
