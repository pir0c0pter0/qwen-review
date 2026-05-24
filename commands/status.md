---
description: Show qwen-review configuration and the last review result for the current workspace
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" status
```

Present the JSON to the user. If `lastReview` is null, mention that no review has run yet.
