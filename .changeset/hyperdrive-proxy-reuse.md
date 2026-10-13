---
"miniflare": patch
---

Reuse Hyperdrive proxy servers across `setOptions()` calls for unchanged bindings

Previously each `setOptions()` left the previous proxy servers listening, even after `dispose()`.
