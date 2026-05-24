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
- If `ready` is true, confirm the plugin is operational in one sentence.
- If `ready` is false, identify which component failed (env if `envOk` is false; API if `ping.ok` is false). When `envOk` is false, the `ping.error` will be a synthetic "QWEN_API_KEY not set" — do not double-report it.
- If `envOk` is false, remind the user to set `QWEN_API_KEY` (and optionally `QWEN_BASE_URL`, `QWEN_MODEL`, `QWEN_REVIEW_MODE`).
- If `ping.ok` is false AND `envOk` is true, surface the error message verbatim.
- If `actionsTaken` is non-empty, summarize what changed in one sentence.
