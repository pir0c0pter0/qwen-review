# Qwen Review Gate — Plugin de stop-time review via API Qwen 3.7 Max

**Status:** design aprovado, aguardando review do usuário antes do plano de implementação.
**Data:** 2026-05-23
**Autor:** Claude (Opus 4.7) + Pir0c0pter0
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
| Escopo do review | `last_assistant_message` + `git diff HEAD` **+ diff sintético de arquivos untracked** (`git ls-files --others --exclude-standard`) + conteúdo integral dos arquivos modificados/criados (capado, com pre-redaction de secrets) |
| Modos de inferência | `fast` (default): sem thinking, `max_tokens: 1024`, timeout 120s, latência 3-15s. `deep`: `enable_thinking=true`, `max_tokens: 8192`, timeout 600s, latência 60-180s. `temperature: 0.2` em ambos. |
| Linguagem | Node ≥18, zero dependências npm (usa `fetch` nativo) |

## 3. Layout do plugin

```
~/.claude/plugins/local/qwen-review/
├── .claude-plugin/
│   └── plugin.json              # name: qwen-review, version: 0.1.0
├── hooks/
│   └── hooks.json               # registra Stop hook → stop-review-hook.mjs (timeout 660s)
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
hooks.json (Stop, timeout 660s) ──► node scripts/stop-review-hook.mjs
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
5. shortcut: se last_assistant vazio E git diff (tracked+untracked) vazio → exit 0 (ALLOW implícito)
6. buildPrompt({last_assistant_message, gitDiff(), changedFilesContent()})
   — `gitDiff()` itera per-arquivo (union de tracked modificados + untracked criados),
     aplica `shouldSkipFile()` ANTES de gerar o diff (sensitive vira placeholder),
     usa `git diff HEAD -- <file>` para tracked e `git diff --no-index /dev/null <file>` para untracked
   — `changedFilesContent()` itera mesma union, mesmo skip + redaction
   — todos os campos textuais passam por redactSecrets() (defesa em camadas) antes da interpolação (ver §5.2)
7. callQwen(prompt) — `max_tokens`, timeout e `enable_thinking` escolhidos por `QWEN_REVIEW_MODE` (fast|deep, ver §6)
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

<changed_files_content>
{{CHANGED_FILES_CONTENT}}
</changed_files_content>

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
- Use `<changed_files_content>` para entender contexto além do diff (callers, tipos, invariantes
  declaradas mais acima no arquivo). Diff sem o arquivo cheio gera falso positivo.
- Não invente: se o diff está vazio e o turno é status/setup → ALLOW.
- Nunca eco literais que pareçam secret (AKIA…, sk-…, eyJ…, ghp_…).
</rules>
```

### 5.1 Truncamento

| Variável | Budget |
|---|---|
| `LAST_ASSISTANT` | head 4000 + `[…truncated…]` + tail 4000 (~8000 chars) |
| `GIT_DIFF` | head 12000 + `[diff truncated]` (sem tail) |
| `CHANGED_FILES_CONTENT` | até 5 arquivos, 4000 chars/arquivo, total cap 16000 |

`changedFilesContent()` lista arquivos do diff (excluindo deletados), aplica file-level skip (§5.2), lê o restante, prefixa com `=== path/to/file ===\n`, redact + trunca por arquivo. Se exceder 5 arquivos ou 16000 chars totais, anexa `\n[N arquivos adicionais omitidos]`.

Evita estourar contexto em turns gigantes; cap total ~12k tokens (margem confortável dentro do limite do qwen3-max).

### 5.2 Redaction de secrets (pre-send, obrigatória por default)

**Motivação:** o prompt sai do host pro provider HTTP (DashScope, OpenRouter, etc.). Conteúdo de arquivo modificado pode incluir credenciais — `.env` editado, chave hardcoded numa linha próxima ao código real alterado, PEM block num teste. Sem redaction, isso vaza para terceiro.

**File-level skip** — arquivos com estes paths são excluídos **tanto** de `CHANGED_FILES_CONTENT` **quanto** de `GIT_DIFF` (o hook itera diff per-arquivo justamente para poder filtrar). Em `CHANGED_FILES_CONTENT` entram como `=== <path> ===\n[file excluded: sensitive path]\n`; em `GIT_DIFF` viram `diff --git a/<path> b/<path>\n[diff excluded: sensitive path]\n`. Padrões cobertos:

- `.env*` (`.env`, `.env.local`, `.env.production`, …)
- `**/*.key`, `**/*.pem`, `**/*.crt`, `**/*.p12`, `**/*.pfx`, `**/*.jks`
- `**/id_rsa*`, `**/id_ed25519*`, `**/id_ecdsa*`
- Paths contendo `secret`, `credential`, `token` (case-insensitive)
- Binários (detectados por byte `0x00` nos primeiros 8KB lidos)

**Content-level redaction** — regex aplicadas em `LAST_ASSISTANT`, `GIT_DIFF` e `CHANGED_FILES_CONTENT`:

| Padrão | Substitui por |
|---|---|
| `AKIA[0-9A-Z]{16}` | `[REDACTED:aws-access-key]` |
| `sk-[A-Za-z0-9_-]{20,}` | `[REDACTED:openai-or-qwen-key]` |
| `gh[pousr]_[A-Za-z0-9]{20,}` | `[REDACTED:github-token]` |
| `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` | `[REDACTED:jwt]` |
| `-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----` | `[REDACTED:pem]` |
| `xox[baprs]-[A-Za-z0-9-]{10,}` | `[REDACTED:slack-token]` |

Diff também é redactado: arquivo modificado pode estar *adicionando* secret na linha `+`.

**Controle do usuário:**
- `QWEN_REVIEW_REDACT_SECRETS=0` desativa redaction (opt-out, **NÃO recomendado**)
- `QWEN_REVIEW_EXCLUDE_GLOBS=glob1:glob2` adiciona globs à lista de skip

**Defesa em camadas:** o prompt ainda instrui Qwen a não ecoar literais que pareçam secret, redundante com a redaction (proteção contra padrão novo que escape do regex).

## 6. Cliente HTTP (`lib/qwen-client.mjs`)

```javascript
const MODE_DEFAULTS = {
  fast: { maxTokens: 1024, timeoutMs: 120_000, enableThinking: false },
  deep: { maxTokens: 8192, timeoutMs: 600_000, enableThinking: true }
};

export async function callQwen({ apiKey, baseUrl, model, prompt, mode = "fast", overrides = {} }) {
  const params = { ...MODE_DEFAULTS[mode], ...overrides };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: params.maxTokens,
    stream: false
  };
  if (params.enableThinking) {
    body.extra_body = { enable_thinking: true };
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Qwen API ${res.status}: ${errBody.slice(0, 300)}`);
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

### 6.1 Modos `fast` vs `deep`

`QWEN_REVIEW_MODE` controla o trade-off entre latência e profundidade:

| Modo | `max_tokens` | timeout HTTP | `enable_thinking` | Latência típica | Quando usar |
|---|---|---|---|---|---|
| `fast` (default) | 1024 | 120s | omitido (false) | 3-15s | Edits rotineiros — bug fix simples, refactor pequeno, doc |
| `deep` | 8192 | 600s | `true` | 60-180s | Edits sensíveis — segurança, lógica de billing, migrações de schema, mudanças em código de auth |

`deep` ativa o reasoning interno do qwen3-max — review mais profundo (cobre invariantes implícitas, casos extremos), mas custa ~10× mais tokens de saída e pode atrasar o stop em até 3 minutos. Hook timeout vai pra 660s (600s API + 60s margem) quando `mode=deep`.

`QWEN_REVIEW_MAX_TOKENS` e `QWEN_REVIEW_TIMEOUT_MS` continuam funcionando como overrides finos sobre o default do modo escolhido.

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
├── redactor.test.mjs         AKIA/sk-/ghp_/JWT/PEM/Slack matching; .env/.key/binary file skip; EXCLUDE_GLOBS user-defined
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

- **Pre-redaction obrigatória por default** (§5.2): file-level skip de paths sensíveis (`.env*`, `*.key`, `*.pem`, paths com `secret`/`credential`/`token`, binários) + content-level regex que mascara AWS/OpenAI/GitHub/Slack tokens, JWTs e PEM blocks ANTES da interpolação no prompt. Aplicado também ao `GIT_DIFF` (não só ao file content).
- Defense in depth: prompt instrui Qwen a não ecoar secrets (redundante com a redaction; cobre padrão novo que escape do regex)
- `QWEN_API_KEY` nunca logada inteira; só sufixo (`sk-•••cde`)
- Sem `shell: true` em nenhum spawn; sempre array de args
- `git diff` é chamado com `--no-color` explícito (defensivo, mesmo sendo o default)
- Timeout duro: HTTP 120s (fast) / 600s (deep); hook 660s no total (cobre worst case deep + margem)
- State files com permissão `0o600` (mesma que o codex usa)

## 11. Variáveis de ambiente

| Var | Obrigatório | Default | Notas |
|---|---|---|---|
| `QWEN_API_KEY` | sim | — | Sem ela, gate auto-skip com aviso |
| `QWEN_BASE_URL` | não | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | OpenAI-compat endpoint |
| `QWEN_MODEL` | não | `qwen3-max` | Override para `qwen-max-latest`, `qwen/qwen3-max` (OpenRouter), etc. |
| `QWEN_REVIEW_MODE` | não | `fast` | `fast` (sem thinking, 1024 tok, 120s) ou `deep` (thinking, 8192 tok, 600s). Ver §6.1 |
| `QWEN_REVIEW_TIMEOUT_MS` | não | `120000` (fast) / `600000` (deep) | Override do timeout HTTP |
| `QWEN_REVIEW_MAX_TOKENS` | não | `1024` (fast) / `8192` (deep) | Override do cap de saída |
| `QWEN_REVIEW_MAX_FILES` | não | `5` | Quantos arquivos enviar em `CHANGED_FILES_CONTENT` |
| `QWEN_REVIEW_REDACT_SECRETS` | não | `1` | `0` desliga redaction de secrets (NÃO recomendado) |
| `QWEN_REVIEW_EXCLUDE_GLOBS` | não | — | Globs extras pra skip de file content, separados por `:` |
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
- ❌ Tool calling / function calling para Qwen buscar callers via grep (v0.2; v0.1 só pré-injeta arquivos completos)
- ❌ Injeção automática de `CLAUDE.md` / convenções (avaliar em v0.2 se BLOCKs falsos por estilo aparecerem)

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
- [ ] Secret em arquivo `.env` modificado NÃO é enviado ao Qwen (file-level skip; bloco aparece como `[file excluded: sensitive path]`)
- [ ] Token `sk-abc123def456…` em arquivo `.ts` modificado é substituído por `[REDACTED:openai-or-qwen-key]` antes do POST (validado por test que inspeciona o `body` do mock fetch)
- [ ] PEM block num teste novo é redactado (validado por test)
- [ ] **Arquivo novo untracked (criado via Write, sem `git add`) dispara review e aparece em `CHANGED_FILES_CONTENT` com diff sintético** (validado por test que cria arquivo + faz hook rodar + checa BLOCK retorna)
- [ ] **Arquivo `.env` untracked recém-criado NÃO tem conteúdo enviado** (validado por test que cria `.env` com `SECRET=xxx`, captura o body do POST, assert que `SECRET=xxx` não aparece e que `[diff excluded: sensitive path]` aparece)
