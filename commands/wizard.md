---
description: Configura QWEN_API_KEY + base URL + model + mode interativamente via AskUserQuestion (sem precisar de terminal real)
allowed-tools: Bash(node:*), AskUserQuestion
---

Você (Claude) é quem vai conduzir o wizard usando `AskUserQuestion` — não precisa do prefixo `!` nem de terminal real. Fluxo:

**1.** Primeiro, leia o estado atual pra mostrar defaults:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" status
```

Anote `apiKey` (mascarada se já existe), `baseUrl`, `model`, `mode`.

**2.** Faça as 4 perguntas via `AskUserQuestion` (em uma única chamada batched — máximo 4 questions). Cada uma com defaults derivados do status:

- **Base URL** — header: "Base URL", 4 options:
  1. `DashScope International` (description: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`)
  2. `DashScope China` (description: `https://dashscope.aliyuncs.com/compatible-mode/v1`)
  3. `OpenRouter` (description: `https://openrouter.ai/api/v1`)
  4. `Custom` (description: cola URL OpenAI-compat de qualquer provider)
  Marque o atual como `(atual)` no label se bater com um preset.

- **Model** — header: "Modelo", 3 options:
  - `qwen3-max` (DashScope)
  - `qwen/qwen3-max` (OpenRouter)
  - `Custom` (outro nome)
  Marque o atual.

- **Mode** — header: "Modo de review", 2 options:
  - `fast (1024 tok, 3-15s, sem thinking) — pro dia-a-dia` (Recommended se atual é fast)
  - `thinking (8192 tok, 60-180s, enable_thinking=true) — review profundo` (Recommended se atual é thinking)

- **API key** — header: "API key", 2 options:
  - Se `envOk: true` (já tem chave): primeira opção `Manter a chave atual` `(Recommended)`, segunda opção `Substituir por uma nova`
  - Se `envOk: false`: primeira opção `Configurar agora`, segunda opção `Pular por enquanto`

> ⚠️ **CRÍTICO**: NUNCA passe a string mascarada (ex: `sk-•••efd`) do `/status` output como `--api-key=...`. O status sempre mascara — não é o valor real da chave. Se o usuário escolhe "Manter", use `--keep-key`. Se escolhe "Substituir", siga a passo 3.

**3.** Se o usuário escolheu:
- **"Custom" base URL** OU **"Custom" model**: faça SEGUNDA `AskUserQuestion` com option `Other` pra capturar texto livre.
- **"Substituir por uma nova" API key**: peça pro usuário no chat — "Cole sua nova API key aqui:" (mensagem normal, não AskUserQuestion). Quando ele colar, valide que tem ≥30 chars e começa com algo plausível tipo `sk-`. Se vier curta demais ou conter `•`, peça pra colar de novo. **NÃO use AskUserQuestion pra isso** — chave em formato livre não combina com options + chaves vão pro transcript de qualquer jeito mas pelo menos no chat normal o usuário tem expectativa clara.
- **"Pular por enquanto"** (envOk=false): aborte o wizard com mensagem "Configure manualmente depois com /qwen-review:wizard ou edite ~/.claude/settings.json".

**4.** Mostre summary curto pro usuário:
```
Vou escrever em ~/.claude/settings.json:
  QWEN_API_KEY      = sk-•••XXX
  QWEN_BASE_URL     = https://...
  QWEN_MODEL        = qwen3-max
  QWEN_REVIEW_MODE  = fast
```
Pergunte via `AskUserQuestion` "Confirmar?" com options `Sim, salvar` / `Não, cancelar`.

**5.** Se confirmado, invoque o apply-config. Escolha **exatamente uma** das formas:

**5a.** Manteve a chave atual:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" apply-config \
  --keep-key \
  --base-url="<url-escolhida>" \
  --model="<modelo-escolhido>" \
  --mode="<fast|thinking>"
```

**5b.** Substituiu por chave nova (usuário colou no passo 3):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" apply-config \
  --api-key="<CHAVE-REAL-COLADA-PELO-USUARIO>" \
  --base-url="<url-escolhida>" \
  --model="<modelo-escolhido>" \
  --mode="<fast|thinking>"
```

> ⚠️ **NUNCA combine `--api-key=...` com `--keep-key`** — são mutuamente exclusivos.
> ⚠️ **NUNCA passe valor mascarado** (com `•`, `*`, ou substring `REDACTED`). O comando rejeita com exit 2 e mensagem clara.

O comando devolve JSON com `ok: true` + `written` + `env` (apiKey mascarada na saída pra log seguro). Reporte ao usuário:
- ✓ Salvo com sucesso
- Lembre dos próximos passos do JSON `nextSteps`:
  - `/reload-plugins`
  - `/qwen-review:setup --enable`
  - `/qwen-review:status`

**Tratamento de erro:** se `apply-config` exit 2 com stderr `missing required ...`, mostre a mensagem e pergunte se quer tentar de novo.

---

**Alternativa terminal** (se o usuário preferir o wizard interativo de readline tradicional):

```
! node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" wizard
```

Mas via AskUserQuestion (fluxo principal acima) é mais ergonômico — funciona dentro do Claude Code direto, sem precisar de `!`.
