---
"wrangler": patch
---

Retry transient API failures for `wrangler workflows instances list` and `wrangler workflows instances describe`

These read-only requests now use bounded retries for transient failures such as HTTP 503 responses and dropped connections.
