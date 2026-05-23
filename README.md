# qwen-review

Design de um plugin para [Claude Code](https://claude.ai/code) que adiciona um **stop-time review gate** usando a API do **Qwen 3.7 Max** (via endpoint OpenAI-compatible).

Inspirado no `stop-review-gate` do plugin oficial `openai-codex` — mesma mecânica de `decision: "block"` no hook `Stop`, mas com uma chamada HTTP direta ao Qwen no lugar do subprocess local.

> **Status:** apenas design / spec. Sem código ainda.

## Como funciona (em uma frase)

Cada vez que o Claude termina um turn, um hook `Stop` chama o Qwen com o último output do Claude + `git diff HEAD`. Se o Qwen retornar `BLOCK: <razão>`, o turn não para — Claude continua e tenta corrigir.

## Documento de design

→ [`docs/superpowers/specs/2026-05-23-qwen-review-gate-design.md`](docs/superpowers/specs/2026-05-23-qwen-review-gate-design.md)

Cobre: layout do plugin, fluxo do hook, política de fail-open, prompt template, cliente HTTP, comandos `/qwen-review:*`, state model, testes, observability, segurança, env vars, não-objetivos (YAGNI) e critérios de aceite.

## Variáveis de ambiente (resumo)

| Var | Obrigatório | Default |
|---|---|---|
| `QWEN_API_KEY` | sim | — |
| `QWEN_BASE_URL` | não | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `QWEN_MODEL` | não | `qwen3-max` |

## Licença

MIT (a definir quando o código for adicionado).
