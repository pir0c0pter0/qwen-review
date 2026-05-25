# qwen-review

Plugin [Claude Code](https://claude.ai/code) que adiciona um **stop-time review gate** usando a API do **Qwen 3.7 Max** (endpoint OpenAI-compatible).

No fim de cada turn do Claude, um hook `Stop` envia ao Qwen o `last_assistant_message` + `git diff HEAD` + conteúdo (pré-redactado) dos arquivos modificados. Se o Qwen responder `BLOCK: <razão>`, o hook devolve `{decision: "block"}` e o Claude Code continua o turn tentando corrigir, em vez de parar.

Inspirado no `stop-review-gate` do plugin oficial `openai-codex`, com chamada HTTP direta no lugar do subprocess local.

---

## 🚀 Instalação

### Via marketplace `pir0c0pter0` (recomendado)

**Forma rápida — slash command:**

```
/plugin marketplace add pir0c0pter0/claude-plugins
/plugin install qwen-review@pir0c0pter0
```

**Forma manual — editar `~/.claude/settings.json`** (útil pra setups compartilhados em team):

```json
{
  "extraKnownMarketplaces": {
    "pir0c0pter0": {
      "source": { "source": "github", "repo": "pir0c0pter0/claude-plugins" }
    }
  },
  "enabledPlugins": {
    "qwen-review@pir0c0pter0": true
  }
}
```

Pela rota manual, **feche e abra o Claude Code** na primeira vez (marketplace nova só carrega no startup).

### Via clone direto (standalone)

```bash
git clone https://github.com/pir0c0pter0/qwen-review ~/.claude/plugins/local/qwen-review
```

(Requer registrar uma marketplace `local` apontando pra `~/.claude/plugins/local/` com manifest.)

### Pré-requisitos

- **Node ≥ 18** no PATH (usa `fetch` nativo, `node:test`, `AbortController`)
- Sem dependências npm

---

## ⚙️ Configuração

### Wizard interativo (recomendado)

Dentro do Claude Code, prefixe com `!` pra rodar em terminal real (necessário pro `readline` funcionar):

```
! node ~/.claude/plugins/cache/pir0c0pter0/claude-plugins/<versão>/qwen-review/scripts/qwen-review.mjs wizard
```

> Descobrir `<versão>`: `ls ~/.claude/plugins/cache/pir0c0pter0/claude-plugins/`

O wizard:

1. **Lê** o `~/.claude/settings.json` atual (cria se não existir)
2. **Mostra** a API key atual mascarada (ex: `sk-•••efd`) e pergunta nova
3. **Lista** 4 presets de base URL:
   - DashScope International (default, conta global Alibaba Cloud)
   - DashScope China (conta cn)
   - OpenRouter (alternativa)
   - Custom (cola qualquer URL OpenAI-compat)
4. **Pergunta** o nome do modelo (default `qwen3-max`)
5. **Oferece** modo:
   - `fast` — 1024 tokens, ~3-15s, sem thinking (default, recomendado pro dia-a-dia)
   - `thinking` — 8192 tokens, ~60-180s, `enable_thinking=true` (review profundo, pra mudanças sensíveis tipo segurança/billing/auth)
6. **Mostra summary** com valores propostos
7. **Pede confirmação** (`y` pra escrever, qualquer outra coisa aborta)
8. **Escreve atomicamente** em `~/.claude/settings.json` preservando todos os outros campos

### Manual

Se preferir editar `~/.claude/settings.json` na mão:

```json
{
  "env": {
    "QWEN_API_KEY": "sk-...",
    "QWEN_BASE_URL": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "QWEN_MODEL": "qwen3-max",
    "QWEN_REVIEW_MODE": "fast"
  }
}
```

### Habilitar o gate no workspace

```
/qwen-review:setup --enable
```

State isolado por SHA-256 do realpath — só habilita no projeto atual.

---

## 📋 Comandos

| Comando | Argumentos | Descrição |
|---|---|---|
| `/qwen-review:wizard` | — | Doc + instrução pra rodar wizard via `!` |
| `/qwen-review:setup` | `[--enable\|--disable]` | Liga/desliga o gate + ping na API |
| `/qwen-review:status` | — | Mostra config + último review (JSON) |
| `/qwen-review:check` | `[--diff-only]` | Roda review manual on-demand contra `git diff HEAD` |

---

## 🌐 Todas as variáveis de ambiente

| Var | Obrigatório | Default | Notas |
|---|---|---|---|
| `QWEN_API_KEY` | sim | — | Sem ela, o gate auto-skip com aviso |
| `QWEN_BASE_URL` | não | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | OpenAI-compat endpoint |
| `QWEN_MODEL` | não | `qwen3-max` | Override para outros nomes |
| `QWEN_REVIEW_MODE` | não | `fast` | `fast` (1024 tok, 120s) ou `thinking` (8192 tok, 600s, `enable_thinking=true`). `deep` é alias backward-compat de `thinking` |
| `QWEN_REVIEW_TIMEOUT_MS` | não | 120000 / 600000 | Override do timeout HTTP |
| `QWEN_REVIEW_MAX_TOKENS` | não | 1024 / 8192 | Override do cap de saída |
| `QWEN_REVIEW_MAX_FILES` | não | 5 | Quantos arquivos enviar em `CHANGED_FILES_CONTENT` |
| `QWEN_REVIEW_REDACT_SECRETS` | não | `1` | `0` desliga redaction (**NÃO recomendado**) |
| `QWEN_REVIEW_EXCLUDE_GLOBS` | não | — | Globs extras pra skip, separados por `:` |
| `QWEN_REVIEW_DEBUG` | não | `0` | `1` grava `.qwen-review-debug.log` no workspace |

---

## 🔐 Segurança

Pre-redaction de secrets é **ligada por default**. Cobre três camadas:

### 1. File-level skip — arquivos inteiros excluídos do prompt

Excluídos como placeholder `[file excluded: <razão>]` antes de qualquer leitura:

- **Path-based:** `.env*`, `*.key`/`*.pem`/`*.crt`/`*.p12`/`*.pfx`/`*.jks`, `id_rsa*`/`id_ed25519*`, paths contendo `secret`/`credential`/`token`
- **Tipo:** binários (detectados por null byte nos primeiros 8KB), não-regular files (devices, sockets, FIFOs)
- **Link-based:** symlinks (nunca seguidos — alvo pode estar fora do repo), hardlinks (`stat.nlink > 1` — pode apontar pra fora do repo)
- **User-defined:** qualquer glob em `QWEN_REVIEW_EXCLUDE_GLOBS`

### 2. Content-level redaction — regex substituem por `[REDACTED:<tipo>]`

Aplicado em `LAST_ASSISTANT`, `GIT_DIFF` (tracked + untracked synthetic), e `CHANGED_FILES_CONTENT`:

| Padrão | Substitui por |
|---|---|
| `AKIA[0-9A-Z]{16}` | `[REDACTED:aws-access-key]` |
| `sk-[A-Za-z0-9_-]{20,}` | `[REDACTED:openai-or-qwen-key]` |
| `gh[pousr]_[A-Za-z0-9]{20,}` | `[REDACTED:github-token]` |
| `eyJ…\.…\.…` (JWT) | `[REDACTED:jwt]` |
| `-----BEGIN…PRIVATE KEY-----…-----END…-----` | `[REDACTED:pem]` |
| `xox[baprs]-…` | `[REDACTED:slack-token]` |

### 3. Local secrets do plugin

- `~/.claude/settings.json` escrito pelo wizard **sempre em `0o600`** (owner-only). Não preservamos `0o644` mesmo se você tinha — credentials file não deve ser legível por outros users.
- `~/.claude/plugins/.../state/<workspace>/state.json` (config + lastReview) em `0o600`
- `QWEN_API_KEY` nunca logada inteira — apenas mascarada (`sk-•••efd`)
- Atomic writes (tmp + rename) com fd controlado pelo `open()` desde o byte zero, sem TOCTOU window

Detalhes na spec: [`docs/superpowers/specs/2026-05-23-qwen-review-gate-design.md`](./docs/superpowers/specs/) §5.2 + §10.

---

## ⚡ Modos `fast` vs `thinking`

| | `fast` (default) | `thinking` |
|---|---|---|
| max_tokens | 1024 | 8192 |
| timeout HTTP | 120s | 600s |
| `enable_thinking` | omitido (false) | `true` |
| Latência típica | 3-15s | 60-180s |
| Custo (tokens out) | 1× | ~8-10× |
| Quando usar | Edits rotineiros — bug fix, refactor, docs | Edits sensíveis — segurança, lógica de billing, migrações de schema, código de auth |

`thinking` ativa o reasoning interno do qwen3-max. Review mais profundo (invariantes implícitas, casos extremos) mas pode atrasar o stop em até 3 minutos. Hook timeout vai pra 660s (600s API + 60s margem) quando `mode=thinking`.

**Backward compat:** `QWEN_REVIEW_MODE=deep` continua funcionando como alias de `thinking` (antes da v0.2 a flag se chamava `deep`).

---

## 🔄 Fluxo do hook Stop

```
Claude termina turn
        │
        ▼
hook (Stop, timeout 660s) → node scripts/stop-review-hook.mjs
        │
        ▼
1. lê stdin: {cwd, session_id, last_assistant_message, ...}
2. resolveWorkspaceRoot(cwd)
3. getConfig → stopReviewGate=false? → exit 0 silent
4. QWEN_API_KEY ausente? → stderr warn + exit 0 (fail-open)
5. shortcut: last_assistant E git diff (tracked+untracked) vazios? → exit 0
6. buildPrompt:
   - GIT_DIFF: per-file iteration, file-skip + symlink/hardlink check
   - CHANGED_FILES_CONTENT: idem + isBinary + per-file cap 4000 chars
   - LAST_ASSISTANT: truncate head 4000 + tail 4000
   - Tudo passa por redactSecrets() antes da interpolação
7. callQwen com mode (fast|thinking) + overrides do env
8. parseDecision(content) — primeira linha ALLOW:/BLOCK:
9. BLOCK → emit {decision:"block", reason:"Qwen review found issues: ..."}
10. Qualquer throw → exit 0 (fail-open) + stderr note
11. saveLastReview(state.json)
```

### Política de fail-open

| Cenário | Decisão |
|---|---|
| `stopReviewGate=false` | allow (silent) |
| `QWEN_API_KEY` ausente | allow + stderr |
| Diff vazio + assistant vazio | allow (shortcut, sem API) |
| Timeout HTTP | allow + stderr |
| HTTP 4xx/5xx | allow + stderr com excerpt do body |
| Resposta sem prefixo `ALLOW:`/`BLOCK:` | allow + stderr |
| `ALLOW: …` | allow (silent) |
| `BLOCK: …` | **block** (Claude continua turn) |

API call HTTP é o único ponto que pode bloquear. Tudo o mais libera o stop.

---

## 🧪 Desenvolvimento

```bash
node --test test/*.test.mjs          # roda todos os testes (68 atualmente)
node scripts/qwen-review.mjs status  # sanity check sem rede
```

Zero deps npm — só Node nativo (`node:test`, `fetch`, `AbortController`, `node:fs/promises`, `readline`).

### Layout

```
qwen-review/
├── .claude-plugin/plugin.json    # metadata
├── hooks/hooks.json              # registra Stop hook (timeout 660s)
├── commands/
│   ├── wizard.md                 # doc do wizard
│   ├── setup.md                  # /qwen-review:setup [--enable|--disable]
│   ├── status.md                 # /qwen-review:status
│   └── check.md                  # /qwen-review:check [--diff-only]
├── prompts/stop-review.md        # template com {{LAST_ASSISTANT}}, {{GIT_DIFF}}, {{CHANGED_FILES_CONTENT}}
├── scripts/
│   ├── stop-review-hook.mjs      # entrada do hook (orquestrador)
│   ├── qwen-review.mjs           # CLI (setup/status/check/wizard)
│   └── lib/
│       ├── workspace.mjs         # resolveWorkspaceRoot
│       ├── config.mjs            # state.json por workspace
│       ├── redactor.mjs          # file-skip + regex
│       ├── prompt.mjs            # template loader/interpolator/truncate
│       ├── qwen-client.mjs       # fetch() OpenAI-compat + modes
│       └── settings.mjs          # atomic writer com 0o600 strict
├── test/                         # 68 testes (Node node:test)
│   ├── workspace.test.mjs
│   ├── config.test.mjs
│   ├── redactor.test.mjs
│   ├── prompt.test.mjs
│   ├── qwen-client.test.mjs
│   ├── settings.test.mjs
│   └── stop-hook.test.mjs        # end-to-end com mock fetch via preload
└── docs/superpowers/
    ├── specs/2026-05-23-qwen-review-gate-design.md
    ├── plans/2026-05-23-qwen-review-gate.md
    └── notes/2026-05-25-llama-cpp-local-analysis.md
```

---

## 🆘 Troubleshooting

Veja a tabela completa no [README do marketplace](https://github.com/pir0c0pter0/claude-plugins#-troubleshooting).

---

## 📝 Licença

MIT.
