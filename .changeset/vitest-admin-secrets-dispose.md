---
"@cloudflare/vitest-plugin": patch
---

Type `adminSecretsStore()` as returning a `Disposable` and document disposing it with `using`

The returned RPC stub was never disposed in the documented example, which made workerd warn "An RPC stub was not disposed properly".
