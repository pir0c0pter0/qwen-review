# qwen-review

Plugin [Claude Code](https://claude.ai/code) que adiciona um **stop-time review gate** usando a API do **Qwen 3.7 Max** (endpoint OpenAI-compatible).

No fim de cada turn do Claude, um hook `Stop` envia ao Qwen o `last_assistant_message` + `git diff HEAD` + conteúdo (pré-redactado) dos arquivos modificados. Se o Qwen responder `BLOCK: <razão>`, o hook devolve `{decision: "block"}` e o Claude Code continua o turn tentando corrigir, em vez de parar.

Inspirado no `stop-review-gate` do plugin oficial `openai-codex`, com chamada HTTP direta no lugar do subprocess local.

## Instalação

```bash
git clone https://github.com/pir0c0pter0/qwen-review ~/.claude/plugins/local/qwen-review
```

(Ou clone em outro lugar e crie um symlink em `~/.claude/plugins/local/qwen-review`.)

Reinicie a sessão Claude Code. O plugin aparece como `qwen-review` em `/plugin list`.

Sem dependências npm — só precisa de **Node ≥ 18** no PATH.

## Configuração

### Wizard interativo (recomendado)

Dentro do Claude Code, rode (com `!` pra abrir terminal real, necessário pra readline):

```
! node ~/.claude/plugins/local/qwen-review/scripts/qwen-review.mjs wizard
```

(ou ajuste o path se você instalou via marketplace)

O wizard pergunta API key, base URL (4 presets + custom), modelo e modo (`fast`/`thinking`), mostra summary, confirma e escreve atomicamente em `~/.claude/settings.json` preservando todos os outros campos.

Depois:
- `/reload-plugins` (ou restart Claude Code)
- `/qwen-review:setup --enable` (liga o gate por workspace)

### Mínimo viável manual

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

Depois `/qwen-review:setup --enable` no workspace. O gate fica habilitado apenas pra esse workspace (state isolado por sha256 do realpath).

### Todas as variáveis de ambiente

| Var | Obrigatório | Default | Notas |
|---|---|---|---|
| `QWEN_API_KEY` | sim | — | Sem ela, o gate auto-skip com aviso |
| `QWEN_BASE_URL` | não | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | OpenAI-compat endpoint |
| `QWEN_MODEL` | não | `qwen3-max` | Override para outros nomes (ex: `qwen/qwen3-max` no OpenRouter) |
| `QWEN_REVIEW_MODE` | não | `fast` | `fast` (1024 tok, 120s, sem thinking) ou `thinking` (8192 tok, 600s, `enable_thinking=true`). `deep` é alias backward-compat de `thinking`. |
| `QWEN_REVIEW_TIMEOUT_MS` | não | 120000 / 600000 | Override do timeout HTTP |
| `QWEN_REVIEW_MAX_TOKENS` | não | 1024 / 8192 | Override do cap de saída |
| `QWEN_REVIEW_MAX_FILES` | não | 5 | Quantos arquivos enviar em `CHANGED_FILES_CONTENT` |
| `QWEN_REVIEW_REDACT_SECRETS` | não | `1` | `0` desliga redaction (NÃO recomendado) |
| `QWEN_REVIEW_EXCLUDE_GLOBS` | não | — | Globs extras pra skip, separados por `:` |
| `QWEN_REVIEW_DEBUG` | não | `0` | `1` grava `.qwen-review-debug.log` no workspace |

## Comandos

| Comando | Descrição |
|---|---|
| `/qwen-review:wizard` | Wizard interativo (instrução pra rodar via `!`) — configura API key, base URL, model e mode em `~/.claude/settings.json` |
| `/qwen-review:setup [--enable\|--disable]` | Liga/desliga o gate no workspace atual + ping na API |
| `/qwen-review:status` | Mostra config + último review |
| `/qwen-review:check [--diff-only]` | Roda review manual on-demand contra `git diff HEAD` |

## Segurança

Pre-redaction de secrets é **ligada por default**. Cobre:

- **File-level skip:** `.env*`, `*.key`/`*.pem`/`*.crt`/`*.p12`, paths com `secret`/`credential`/`token`, binários — nunca entram no prompt
- **Content-level regex:** AWS keys, OpenAI/Qwen keys (`sk-…`), GitHub tokens (`ghp_…`/`gho_…`), JWTs, PEM private key blocks, Slack tokens — substituídos por `[REDACTED:<tipo>]`
- Aplicado também no `git diff` (não só nos arquivos)

Ver `docs/superpowers/specs/2026-05-23-qwen-review-gate-design.md` §5.2 e §10.

## Troubleshooting

| Sintoma | Diagnóstico | Fix |
|---|---|---|
| Gate não dispara | `stopReviewGate=false` no state | `/qwen-review:setup --enable` |
| stderr "QWEN_API_KEY not set" | env var ausente na sessão Claude Code | Adicione no shell profile, reinicie sessão |
| Reviews lentos (>30s) | Modo `deep` ativo | `unset QWEN_REVIEW_MODE` para voltar pra `fast` |
| Block falso por estilo | Modelo opinou sobre estética | Atualize o template ou ajuste o prompt — não há suporte pra CLAUDE.md ainda (v0.2) |
| API rejeita modelo | `qwen3-max` não disponível no seu provider | Tente `QWEN_MODEL=qwen-max-latest` ou ajuste para o nome aceito |

## Desenvolvimento

```bash
node --test test/*.test.mjs    # roda todos os testes
node scripts/qwen-review.mjs status    # sanity check sem rede
```

Zero deps npm — tudo é Node nativo (`node:test`, `fetch`, `AbortController`).

## Licença

MIT.
