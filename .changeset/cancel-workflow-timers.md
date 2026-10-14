---
"@cloudflare/workflows-shared": patch
---

Cancel step timeout and grace period timers when they are no longer needed

Completed steps previously left their timeout timers active, which could exhaust the 10,000 active timer quota in long running local Workflows.
