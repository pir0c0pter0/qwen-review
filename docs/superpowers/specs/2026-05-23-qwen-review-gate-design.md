# Qwen Review Gate — Plugin de stop-time review via API Qwen 3.7 Max

**Status:** design aprovado, aguardando review do usuário antes do plano de implementação.
**Data:** 2026-05-23
**Autor:** Claude (Opus 4.7) + Mario
**Inspiração:** plugin `openai-codex` (estrutura de hooks/commands/state/scripts)

---

## 1. Objetivo

Criar um plugin Claude Code que, ao final de cada turn do Claude, chama a API Qwen 3.7 Max via endpoint OpenAI-compatible para revisar criticamente o que Claude acabou de fazer. Se o Qwen identificar problema bloqueante, o hook devolve `decision: "block"` e o Claude Code continua o turn tentando corrigir, em vez de parar.

Comportamento espelha o `stop-review-gate` do plugin codex (`/home/mariostjr/.claude/plugins/cache/openai-codex/codex/1.0.4/hooks/hooks.json`), mas troca o subprocess local `codex task` por uma chamada HTTP simples.

## 2. Decisões de projeto (já confirmadas com o usuário)

| Decisão | Escolha |
|---|---|
| Modelo padrão | `qwen3-max` (configurável via env) |
| Endpoint padrão | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (OpenAI-compat do DashScope internacional) |
| Distribuição | Plugin completo (hooks + commands + scripts + skills), no padrão do codex |
| Credenciais | Env vars: `QWEN_API_KEY` (obrigatório), `QWEN_BASE_URL`, `QWEN_MODEL` |
| Comportamento do gate | `decision: "block"` quando Qwen devolve `BLOCK:` |
| Política de erro | Fail-open: qualquer falha de rede / 5xx / timeout / parse libera o stop |
| Escopo do review | `last_assistant_message` + `git diff HEAD` (staged + unstaged) |
| Modo de inferência | Sem thinking, `temperature: 0.2`, `max_tokens: 1024`, timeout HTTP 120s |
| Linguagem | Node ≥18, zero dependências npm (usa `fetch` nativo) |

## 3. Layout do plugin

```
~/.claude/plugins/local/qwen-review/
├── .claude-plugin/
│   └── plugin.json              # name: qwen-review, version: 0.1.0
├── hooks/
│   └── hooks.json               # registra Stop hook → stop-review-hook.mjs (timeout 180s)
├── commands/
│   ├── setup.md                 # /qwen-review:setup [--enable|--disable]
│   ├── status.md                # /qwen-review:status
│   └── check.md                 # /qwen-review:check [--diff-only]
├── scripts/
│   ├── stop-review-hook.mjs     # entrada do hook Stop
│   ├── qwen-review.mjs          # CLI multiplex (setup|status|check) + chamada HTTP
│   └── lib/
│       ├── config.mjs           # state.json por workspace (slug + sha256 do path)
│       ├── qwen-client.mjs      # fetch() para /chat/completions com AbortController
│       ├── prompt.mjs           # carrega template e interpola {{VAR}}
│       └── workspace.mjs        # resolveWorkspaceRoot (git root → cwd)
├── prompts/
│   └── stop-review.md           # template com {{LAST_ASSISTANT}}, {{GIT_DIFF}}
├── test/
│   ├── parse-decision.test.mjs
│   ├── prompt.test.mjs
│   ├── config.test.mjs
│   ├── stop-hook.test.mjs       # mock fetch global
│   └── qwen-client.test.mjs
└── README.md
```

State por workspace fica em `${CLAUDE_PLUGIN_DATA}/state/<slug>-<hash16>/state.json` — mesma estratégia do codex (`state.mjs` 29-44) para que o toggle do gate não vaze entre projetos. Slug = basename do workspace root sanitizado; hash = sha256(realpath) truncado em 16 chars.

## 4. Fluxo do hook Stop

```
Claude Code termina turn
        │
        ▼
hooks.json (Stop, timeout 180s) ──► node scripts/stop-review-hook.mjs
        │
        ▼
1. lê stdin JSON: {cwd, session_id, last_assistant_message, transcript_path, hook_event_name}
2. resolveWorkspaceRoot(cwd) → workspaceRoot
3. getConfig(workspaceRoot)
     ├─ stopReviewGate=false → exit 0 (sem decisão)
     └─ true → continua
4. validateEnv()
     ├─ QWEN_API_KEY ausente → log stderr + exit 0 (fail-open)
     └─ ok → continua
5. shortcut: se last_assistant vazio E git diff vazio → exit 0 (ALLOW implícito)
6. buildPrompt({last_assistant_message, gitDiff()})
7. callQwen(prompt) com AbortController(120_000ms)
8. parseDecision(content):
     ├─ /^ALLOW:/ → exit 0
     ├─ /^BLOCK:/ → emit {decision:"block", reason:"Qwen review found issues: <texto>"}
     └─ outra coisa → log stderr + exit 0 (fail-open)
9. qualquer throw → log stderr + exit 0 (fail-open)
10. saveLastReview(workspaceRoot, {decision, reason, latencyMs, tokens, model, ts})
```

### 4.1 Política de fail-open (diferença vs codex)

O codex falha fechado em casos como subprocess crash, porque o subprocess é local e determinístico. Aqui, a chamada externa HTTP tem muito mais modos de falha (rede, rate-limit, expiração de chave, instabilidade do provider). Bloquear o stop em todos esses cenários vira ruído frequente e treina o usuário a desativar o gate.

| Cenário | stderr (vira `additionalContext`) | Decisão |
|---|---|---|
| `stopReviewGate=false` | nada | allow |
| `QWEN_API_KEY` ausente | `qwen-review: QWEN_API_KEY not set; gate skipped. Run /qwen-review:setup.` | allow |
| Diff vazio + assistant vazio | nada | allow (atalho) |
| Timeout 120s | `qwen-review: request timed out after 120s; gate skipped.` | allow |
| HTTP 4xx (auth/quota) | `qwen-review: API rejected request (HTTP 401): <msg>` | allow |
| HTTP 5xx | `qwen-review: API error (HTTP 503); gate skipped.` | allow |
| Resposta sem `ALLOW:`/`BLOCK:` | `qwen-review: unexpected response shape; gate skipped.` | allow |
| `ALLOW: …` | nada | allow |
| `BLOCK: …` | nada (texto vai no `reason`) | **block** |

### 4.2 Formato exato da decisão (mesmo contrato do codex)

Stdout do hook quando bloqueia:
```json
{"decision": "block", "reason": "Qwen review found issues: <primeira linha do BLOCK:>"}
```

Quando libera, hook simplesmente sai com código 0 sem stdout.

## 5. Prompt template

Arquivo `prompts/stop-review.md`. Interpolação `{{VAR}}` (idêntica ao codex `prompts.mjs`).

```markdown
<task>
Você é um revisor crítico do turno anterior do Claude Code.
Revise SOMENTE as mudanças de código feitas nesse último turn.
Output puramente informativo (status, setup, resumo, login check) NÃO conta como
trabalho revisável — devolva ALLOW imediatamente.
Não bloqueie por edits de turns anteriores; só pelo que mudou agora.
</task>

<previous_assistant_message>
{{LAST_ASSISTANT}}
</previous_assistant_message>

<git_diff_head>
{{GIT_DIFF}}
</git_diff_head>

<output_contract>
Sua primeira linha DEVE ser exatamente:
- ALLOW: <razão curta>
- BLOCK: <razão curta, < 200 chars, acionável>
Nada antes dessa linha. Não use markdown na primeira linha.
</output_contract>

<rules>
- ALLOW se: sem mudanças de código, sem problemas bloqueantes, ou só dúvidas estilísticas.
- BLOCK se: bug claro, regressão, segurança (injection/secrets/auth quebrada), API quebrada,
  teste falhando que deveria passar, lógica contradiz o que o assistente afirmou na resposta.
- Cite arquivo:linha quando for BLOCK.
- Não invente: se o diff está vazio e o turno é status/setup → ALLOW.
- Nunca eco literais que pareçam secret (AKIA…, sk-…, eyJ…, ghp_…).
</rules>
```

### 5.1 Truncamento

- `LAST_ASSISTANT`: head 4000 chars + `\n[…truncated…]\n` + tail 4000 chars (total ~8000)
- `GIT_DIFF`: head 12000 chars + `\n[diff truncated]\n` (sem tail, só head — primeira mudança costuma ser a mais informativa)

Evita estourar contexto em turns gigantes e cap em `~25k tokens` de prompt no pior caso.

## 6. Cliente HTTP (`lib/qwen-client.mjs`)

```javascript
export async function callQwen({ apiKey, baseUrl, model, prompt, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1024,
        stream: false
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Qwen API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage ?? {};
    return { content, usage };
  } finally {
    clearTimeout(timer);
  }
}
```

Compatível com qualquer endpoint OpenAI-compat (DashScope, OpenRouter, vLLM local, etc.) — só muda `QWEN_BASE_URL`.

## 7. Comandos `/qwen-review:*`

| Comando | Argumentos | Função |
|---|---|---|
| `/qwen-review:setup` | `[--enable\|--disable]` | Valida env, faz ping (chat completion de 1 token contra o modelo), liga/desliga gate no workspace atual. Sem flag → só relata. |
| `/qwen-review:status` | — | Mostra gate on/off, env vars presentes (key mascarada), último review (decisão, razão, latência, tokens). |
| `/qwen-review:check` | `[--diff-only]` | Roda review manual on-demand contra `git diff HEAD`. Útil para testar config sem fechar o turn. `--diff-only` ignora último assistant message. |

### 7.1 Output do `/qwen-review:setup --json`

```json
{
  "ready": true,
  "envOk": true,
  "apiKey": "sk-•••cde",
  "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3-max",
  "reviewGateEnabled": true,
  "ping": { "ok": true, "latencyMs": 412 },
  "actionsTaken": ["Enabled the stop-time review gate for /var/home/mariostjr/Projetos/skillAPI."]
}
```

### 7.2 State model

`state.json`:
```json
{
  "version": 1,
  "config": {
    "stopReviewGate": false
  },
  "lastReview": {
    "ts": "2026-05-23T12:34:56Z",
    "decision": "block",
    "reason": "logic in foo.js:42 contradicts assistant's claim",
    "model": "qwen3-max",
    "latencyMs": 4231,
    "promptTokens": 1820,
    "completionTokens": 38
  }
}
```

`stopReviewGate` default **false** — instalação não bloqueia até `/qwen-review:setup --enable`. Mesma postura defensiva do codex (`state.mjs:24`).

## 8. Testes

Node `node:test` + `node:assert`, zero dependências externas. Rodável com `node --test test/`.

```
test/
├── parse-decision.test.mjs   ALLOW:, BLOCK:, vazio, prefixo invariante, case-sensitivity
├── prompt.test.mjs           interpolação {{VAR}}, truncamento head/tail, variável faltando
├── config.test.mjs           read/write state.json, isolamento entre slugs, migração v0→v1
├── stop-hook.test.mjs        mock global.fetch — gate off, no key, BLOCK, ALLOW, timeout, 5xx, parse inválido, diff vazio
└── qwen-client.test.mjs      mock fetch — auth header presente, AbortController dispara em timeout, erro 4xx propaga body
```

Cobertura mínima: cada linha do switch de decisão em `stop-review-hook.mjs` exercitada.

## 9. Observability

- `state.lastReview` atualizado a cada chamada (visível em `/qwen-review:status`)
- stderr do hook → vai pro transcript de Claude Code como `additionalContext`, então o usuário sempre vê quando o gate pulou e por quê
- Sem telemetria externa, sem log files por padrão
- `QWEN_REVIEW_DEBUG=1` → grava `.qwen-review-debug.log` no workspace com prompt completo + resposta crua (útil para iterar template)

## 10. Segurança

- `QWEN_API_KEY` nunca logada inteira; só sufixo (`sk-•••cde`)
- Prompt tem regra explícita anti-eco de strings que pareçam secret
- Sem `shell: true` em nenhum spawn; sempre array de args
- `git diff` é chamado com `--no-color` explícito (defensivo, mesmo sendo o default)
- Timeout duro de 120s na chamada HTTP, 180s no hook inteiro (margem para parse/disk)
- State files com permissão `0o600` (mesma que o codex usa)

## 11. Variáveis de ambiente

| Var | Obrigatório | Default | Notas |
|---|---|---|---|
| `QWEN_API_KEY` | sim | — | Sem ela, gate auto-skip com aviso |
| `QWEN_BASE_URL` | não | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | OpenAI-compat endpoint |
| `QWEN_MODEL` | não | `qwen3-max` | Override para `qwen-max-latest`, `qwen/qwen3-max` (OpenRouter), etc. |
| `QWEN_REVIEW_TIMEOUT_MS` | não | `120000` | Timeout da chamada HTTP |
| `QWEN_REVIEW_MAX_TOKENS` | não | `1024` | Cap de saída do modelo |
| `QWEN_REVIEW_DEBUG` | não | `0` | `1` ativa log no workspace |

## 12. Não-objetivos (YAGNI)

- ❌ Streaming SSE (resposta é < 1KB; não precisa)
- ❌ Retry automático em 5xx (fail-open já cobre; retry só atrasaria o stop)
- ❌ Cache de reviews (cada turn é único)
- ❌ Job queue / async (igual codex em modo direct startup; chamada é síncrona dentro do hook)
- ❌ Suporte multi-modelo simultâneo (1 endpoint, 1 modelo por workspace)
- ❌ UI / TUI (output puro JSON ou texto via comandos)
- ❌ Telemetria externa
- ❌ Integração com `superpowers:code-review` (escopo separado)

## 13. Roadmap de implementação (resumido — detalhe vai no plano)

1. Scaffold do plugin (`plugin.json`, layout de pastas)
2. `lib/workspace.mjs` + `lib/config.mjs` + testes
3. `lib/prompt.mjs` + template + testes
4. `lib/qwen-client.mjs` + testes (mock fetch)
5. `scripts/stop-review-hook.mjs` + testes end-to-end (mock fetch global)
6. `scripts/qwen-review.mjs` (CLI: setup, status, check) + commands/*.md
7. `hooks/hooks.json` registrando Stop
8. README.md (instalação, env vars, troubleshooting)
9. Smoke test manual: enable gate, fazer edit pequeno errado, confirmar BLOCK; desabilitar, confirmar pass-through

## 14. Critérios de aceite

- [ ] `plugin install` local funciona sem `npm install`
- [ ] Com `stopReviewGate=false` (default), hook não chama API e não bloqueia
- [ ] Com gate on + key válida + edit com bug óbvio (ex: `return undefiend`), Claude recebe `decision: block` e continua trabalhando
- [ ] Com gate on + edit limpo, hook libera (exit 0) em < 10s típico
- [ ] Sem `QWEN_API_KEY`, hook escreve aviso e libera (não bloqueia)
- [ ] Timeout, 5xx, JSON inválido → fail-open com mensagem clara no stderr
- [ ] `/qwen-review:status` mostra último review e config
- [ ] `node --test test/` passa 100%
