---
"miniflare": patch
---

Reuse connections for `dispatchFetch()` instead of closing the connection after every request

Previously every request forced `reset: true`, using one ephemeral port (left in `TIME_WAIT`) per request, which could exhaust the port pool on CI machines.
