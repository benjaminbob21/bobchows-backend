# Study B — Sync Mechanism Benchmark Results

**Date:** November 9–10, 2026 · **Environment:** local dev (Express + Socket.IO on macOS, MongoDB Atlas)
**Group order under test:** `6af036569525c858d0c29780` · **Workloads:** 10 / 50 / 100 concurrent clients
**Method:** Each run simulated one state change every 3s via the dev-only `/api/benchmark/emit` endpoint
(a stand-in for a Stripe payment confirmation). Each run lasted 20s. WebSocket (50-user) runs were
repeated 3× to check run-to-run variance.

## Results table

| Users | Mode      | Update latency p50 | p95 | max | Consistency p50 | p95 | Error rate |
|-------|-----------|--------------------|-----|-----|-----------------|-----|------------|
| 10    | WebSocket | 1 ms               | 2   | 3   | 1 ms            | 2   | 0.00%      |
| 10    | Polling   | 39 ms              | 43  | 45  | 1946 ms         | 2085| 0.00%      |
| 50    | WebSocket | 2 ms               | 5   | 8   | 2 ms            | 5   | 0.00%      |
| 50    | Polling   | 55 ms              | 89  | 326 | 1971 ms         | 2094| 0.00%      |
| 100   | WebSocket | 3 ms               | 7   | 11  | 3 ms            | 7   | 0.00%      |
| 100   | Polling   | 138 ms             | 1029| 1107| 1947 ms         | 2093| 0.00%      |

WebSocket 50-user repeatability (3 reps): p95 latency 5 / 5 / 5 ms · p95 consistency 5 / 5 / 5 ms · 0 errors

## Protocol targets vs. measured

| Metric                  | Target | WebSocket (100u) | Polling (100u) | Verdict          |
|-------------------------|--------|------------------|----------------|------------------|
| Update latency p95      | ≤ 500 ms | 7 ms         | 1029 ms        | WS passes; polling FAILS |
| Read-your-write p95     | ≤ 1 s    | 7 ms         | 2093 ms        | WS passes; polling FAILS |
| Error rate              | ≤ 1%     | 0.00%         | 0.00%          | Both pass        |

## Interpretation
- WebSocket push keeps read-your-write consistency in single-digit milliseconds and is flat across
  10 → 100 users (p95 2 → 7 ms), i.e. the fan-out cost of Socket.IO rooms is negligible at this scale.
- Polling's 5 s cadence caps how fast a client can ever see a change; measured p95 ≈ 2.1 s misses the
  protocol's 1 s consistency target by ~2× — and update latency degrades to ~1 s at 100 users because
  every poll re-serializes the full group-order document.
- **Decision:** Socket.IO real-time sync is the production default (`USE_WEBSOCKET=true`); polling is
  retained behind the flag as a degraded fallback (e.g. restrictive corporate networks that block WS).
