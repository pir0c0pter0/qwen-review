---
description: Toggle the Qwen review gate AND/OR set per-workspace mode (fast|thinking). Pings the API and prints status JSON.
argument-hint: '[--enable|--disable] [--fast|--thinking|--mode=fast|--mode=thinking]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" setup $ARGUMENTS
```

Argument combinations the user may type:
- `--enable` → liga o gate (modo herda do env `QWEN_REVIEW_MODE`, default `fast`)
- `--disable` → desliga o gate
- `--thinking` (= `--mode=thinking` = `--deep`) → fixa modo `thinking` neste workspace (8192 tokens, ~60-180s, `enable_thinking=true`)
- `--fast` (= `--mode=fast`) → fixa modo `fast` neste workspace
- `--enable --thinking` → habilita gate JÁ no modo thinking (uso comum: workspace de auth/billing/segurança)
- `--disable --fast` → desabilita gate, mantém preferência de modo pro próximo enable

Output rules:
- Present the JSON output to the user.
- If `ready` is true, confirm the plugin is operational in one sentence.
- If `ready` is false, identify which component failed (env if `envOk` is false; API if `ping.ok` is false). When `envOk` is false, the `ping.error` será uma synthetic "QWEN_API_KEY not set" — do not double-report it.
- Se `envOk` false, lembre o usuário de setar `QWEN_API_KEY` (e opcionais `QWEN_BASE_URL`, `QWEN_MODEL`).
- Se `ping.ok` false e `envOk` true, surface the error message verbatim.
- Se `actionsTaken` não-vazio, resuma o que mudou (gate on/off + mode set) em uma frase.
- Mencione o `mode` final escolhido e se vem de workspace override (`modeSource: "workspace"`) ou env global (`modeSource: "env"`).
