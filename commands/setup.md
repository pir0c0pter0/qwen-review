---
description: Toggle the Qwen 3.7 Max stop-time review gate for the current workspace and ping the API
argument-hint: '[--enable|--disable]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" setup $ARGUMENTS
```

Output rules:
- Present the JSON output to the user.
- If `envOk` is false, remind the user to set `QWEN_API_KEY` (and optionally `QWEN_BASE_URL`, `QWEN_MODEL`, `QWEN_REVIEW_MODE`).
- If `ping.ok` is false, surface the error message verbatim.
- If `actionsTaken` is non-empty, summarize what changed in one sentence.
