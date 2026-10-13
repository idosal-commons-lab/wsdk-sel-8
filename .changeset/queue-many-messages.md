---
"miniflare": patch
---

Fix `QuotaExceededError` when sending many messages to a queue locally

The queue broker no longer registers a timer for every undelayed message, which could exceed workerd's limit of 10,000 active timeouts.
