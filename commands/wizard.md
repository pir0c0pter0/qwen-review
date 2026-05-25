---
description: Interactive wizard to configure QWEN_API_KEY, base URL, model, and mode (writes to ~/.claude/settings.json)
---

The wizard precisa de stdin interativo, então **deve rodar via `!` no Claude Code** (que abre terminal real), não via slash command direto.

Diga para o usuário rodar:

```
! node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" wizard
```

(o `!` no início faz o Claude Code executar no terminal do usuário ao invés de via Bash tool, preservando readline)

O wizard pergunta:
1. **API key** (mostra a atual mascarada, blank pra manter)
2. **Base URL** (4 presets: DashScope Internacional/China, OpenRouter, ou Custom)
3. **Model** (default `qwen3-max`)
4. **Mode** (`fast` rápido / `thinking` profundo)

No final mostra summary e pede confirmação. Se yes, escreve atomicamente em `~/.claude/settings.json` preservando todos os outros campos do arquivo.

Depois orienta o usuário a:
- `/reload-plugins`
- `/qwen-review:setup --enable` (no workspace dele)
- `/qwen-review:status` (verificar config + ping)
