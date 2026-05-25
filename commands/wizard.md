---
description: Show the ready-to-paste wizard command (interactive config of QWEN_API_KEY, base URL, model, mode)
allowed-tools: Bash(echo:*)
---

O wizard precisa de stdin interativo, então **roda via `!` no Claude Code** (terminal real, não via Bash tool).

Run:

```bash
echo ""
echo "Copie e cole a linha abaixo no Claude Code (o ! no início é essencial):"
echo ""
echo "! node \"${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs\" wizard"
echo ""
echo "Ou crie um alias permanente (uma vez só):"
echo "  echo 'alias qwen-wizard=\"node ${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs wizard\"' >> ~/.bashrc"
echo "  source ~/.bashrc"
echo "Depois, sempre que quiser configurar:"
echo "  ! qwen-wizard"
echo ""
```

Depois de exibir o output, lembre o usuário:

**O wizard pergunta (em sequência):**
1. **API key** — mostra a atual mascarada (`sk-•••xyz`), Enter sem digitar mantém
2. **Base URL** — 4 presets pra escolher por número:
   1. DashScope International (Alibaba Cloud global, padrão)
   2. DashScope China (conta cn)
   3. OpenRouter
   4. Custom (cole sua URL)
3. **Model** — default `qwen3-max` (pode trocar pro nome aceito no seu provider)
4. **Mode** — `fast` (1024 tok, 3-15s) ou `thinking` (8192 tok, 60-180s, deep reasoning)

**Resultado:** summary com todos os valores → confirmação `y/N` → escrita atômica em `~/.claude/settings.json` (mode `0o600`, owner-only, preserva todos os outros campos).

**Próximos passos (após wizard terminar):**
- `/reload-plugins` (pega env vars novas)
- `/qwen-review:setup --enable` (liga o gate no projeto atual)
- `/qwen-review:setup --enable --thinking` (liga + força modo thinking só nesse workspace)
- `/qwen-review:status` (confirma config + ping na API + mostra modeSource)
