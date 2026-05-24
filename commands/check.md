---
description: Run an on-demand Qwen review of the current git diff (does not affect the Stop gate)
argument-hint: '[--diff-only]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" check $ARGUMENTS
```

Output rules:
- Show the raw Qwen output to the user (it will start with `ALLOW:` or `BLOCK:` followed by a short reason).
- Do not interpret the result as a hard block — this command is informational only.
- If the command exits non-zero (e.g., `QWEN_API_KEY` not set), surface the stderr message and remind the user to configure their environment.
