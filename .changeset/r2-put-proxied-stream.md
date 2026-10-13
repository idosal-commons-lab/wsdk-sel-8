---
"miniflare": patch
---

Fix `getR2Bucket()` `put()` rejecting a stream body returned by `get()`

Streams proxied from Node.js have no known length, which R2 requires. They are now buffered before being passed to `R2Bucket#put()`.
