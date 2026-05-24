---
description: Show qwen-review configuration and the last review result for the current workspace
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" status
```

Output rules:
- Present the JSON to the user.
- If `envOk` is false, remind the user to set `QWEN_API_KEY`.
- If `reviewGateEnabled` is false, note that the stop-time gate is currently OFF (suggest `/qwen-review:setup --enable` if they want to enable it).
- If `lastReview` is null, mention that no review has run yet.
