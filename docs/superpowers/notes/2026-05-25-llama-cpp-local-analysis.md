# Análise: suporte a llama.cpp local com Qwen como provider alternativo

**Data:** 2026-05-25
**Contexto:** v0.1 do qwen-review usa exclusivamente API HTTP (default DashScope). Pergunta: quanto trabalho pra adicionar opção de rodar via `llama.cpp` local com modelo Qwen GGUF?

## TL;DR

**Já funciona sem alterar código** — `llama-server` expõe endpoint OpenAI-compat. Basta o usuário rodar o server e setar 3 env vars. Trabalho restante é UX (descoberta + defaults sensatos) e doc. **Opção B recomendada** (~80 LOC + doc), não Opção C (plugin-managed lifecycle).

## O que já funciona hoje (Opção A — zero código)

`llama-server` (binário do projeto `ggml-org/llama.cpp`) expõe:
- `POST /v1/chat/completions` (OpenAI-compat, mesma shape que usamos)
- `POST /v1/completions`
- `GET /v1/models`
- Roda sem autenticação por default (binding em localhost só)
- Aceita `Authorization: Bearer <qualquer-coisa>` se passar `--api-key`

**Setup atual sem mudança no plugin:**

```bash
# 1. instalar (Fedora)
sudo dnf install llama-cpp

# 2. baixar modelo (escolha o que cabe na RAM/VRAM)
wget https://huggingface.co/Qwen/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/qwen2.5-coder-32b-instruct-q4_k_m.gguf

# 3. subir server
llama-server -m qwen2.5-coder-32b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 \
  --ctx-size 32768 \
  -ngl 99   # offload to GPU

# 4. configurar plugin
export QWEN_API_KEY=dummy            # qualquer string (não validada)
export QWEN_BASE_URL=http://127.0.0.1:8080/v1
export QWEN_MODEL=qwen2.5-coder-32b  # ignorado pelo llama-server, só pra log
export QWEN_REVIEW_TIMEOUT_MS=300000 # local é mais lento que API

# 5. usar normal
/qwen-review:setup --enable
```

**Tested mentally — nenhuma incompatibilidade visível no path crítico.** O hook hoje:
- Manda `Authorization: Bearer <key>` → llama-server ignora se não tiver `--api-key` setado
- Manda `model: "qwen3-max"` → llama-server ignora (só tem 1 modelo carregado)
- Manda `temperature: 0.2, max_tokens: 1024, stream: false` → todos suportados
- Em deep mode manda `extra_body: { enable_thinking: true }` → **llama-server provavelmente ignora silenciosamente** (não é parâmetro padrão OpenAI; qwen3-max DashScope-specific)

## O que NÃO é trivial

### 1. Modelo: `qwen3-max` não existe como GGUF

`qwen3-max` é hosted-only (parâmetros 235B+ MoE, não distribuído quantizado). Para uso local:

| Modelo | Tamanho aprox. Q4_K_M | VRAM mínimo | Qualidade pra review |
|---|---|---|---|
| Qwen2.5-Coder-7B | 4.5 GB | 8 GB | Mediana, OK pra triagem |
| Qwen2.5-Coder-14B | 8.5 GB | 12 GB | Boa, recomendada balance |
| Qwen2.5-Coder-32B | 19 GB | 24 GB | Próxima de GPT-4 / qwen-max em code |
| Qwen3-30B-A3B (MoE) | 18 GB | 24 GB | Comparable, MoE roda rápido em CPU |
| Qwen2.5-72B | 41 GB | 48 GB+ | Topo, precisa server-class |

**Implicação:** modo `fast` (1024 tokens) é viável em quase todo modelo. Modo `deep` (8192 tokens + thinking) só faz sentido com 32B+ e GPU decente — e mesmo assim levaria 2-5 min.

### 2. Latência mata o UX do gate

| Hardware | Modelo | Tokens/s | 1024 tok |
|---|---|---|---|
| Mac M3 Max | Qwen2.5-Coder-32B Q4 | ~25-35 | ~30-40s |
| RTX 4090 | Qwen2.5-Coder-32B Q4 | ~40-60 | ~20-25s |
| RTX 3060 12GB | Qwen2.5-Coder-14B Q4 | ~35-50 | ~25-30s |
| CPU only (Ryzen 9) | Qwen2.5-Coder-7B Q4 | ~5-10 | ~2-3 min |

API atual (`qwen3-max` via DashScope) responde em **3-15s** em `fast` mode. Local em **20-180s** dependendo de hardware. Isso muda o trade-off do gate: pode virar fricção real ("toda vez que termino um turn espero 30s").

Mitigação possível: manter o server quente (já é o caso quando rodando standalone), preferir modelos menores em `fast` mode.

### 3. Diferenças OpenAI-compat sutis

llama-server tem alguns desvios:
- **`extra_body` não é repassado** — qualquer extensão custom (incluindo `enable_thinking`) é dropada. Isso significa que o modo `deep` perde sua diferença principal vs `fast`.
- **`tokens_predict`** é o nome nativo, `max_tokens` é alias OpenAI-compat (funciona)
- **Streaming SSE** tem formato ligeiramente diferente — não usamos, então sem impacto
- **`stop` array** comporta-se igual

### 4. Gestão de lifecycle (se quisermos automatizar)

Se o plugin tentasse gerenciar o `llama-server`:
- Detectar se já está rodando (check porta + curl /health)
- Spawn como child process detached
- Manter PID, matar no plugin uninstall
- Gerenciar conflito de portas
- Handle crash + restart
- Logging

Isso é **território de complexidade significativa**. Não recomendo pra v0.2.

## Opções

### Opção A — Doc-only (~0 LOC, ~30 min doc)

- README ganha seção "Local com llama.cpp"
- Snippet de setup (env vars + comando `llama-server`)
- Tabela de modelos recomendados por hardware
- Nota sobre latência + sobre `deep` mode ser menos efetivo localmente

**Custo:** mínimo. **Benefício:** habilita 100% do caso. **Trade-off:** usuário descobre os defaults sozinho.

### Opção B — Profile/preset system (~80 LOC + tests + doc) ⭐ RECOMENDADA

- Nova env: `QWEN_PROVIDER=dashscope|local|openrouter|custom` (default `dashscope`)
- Quando `local`: 
  - default `QWEN_BASE_URL=http://127.0.0.1:8080/v1` se não setado
  - default `QWEN_REVIEW_TIMEOUT_MS=300000` (5 min)
  - **omite** `Authorization` header (server local sem auth)
  - **omite** `extra_body.enable_thinking` mesmo em deep mode
  - `QWEN_API_KEY` torna-se opcional
- Comando `/qwen-review:setup --provider=local` força a config
- `/qwen-review:status` mostra qual provider está ativo
- Testes:
  - `header.Authorization === undefined` quando provider=local
  - `body.extra_body === undefined` quando provider=local mesmo com mode=deep
  - default `timeoutMs` muda quando provider=local

**Custo:** ~80 LOC em `qwen-client.mjs` + `stop-review-hook.mjs` + 6 tests. **Benefício:** zero fricção pro usuário com llama-server rodando + comportamento previsível. **Trade-off:** introduz conceito de "provider" como primitivo.

### Opção C — Plugin-managed lifecycle (~400 LOC + integração complexa) ❌ não recomendada pra v0.2

- Plugin detecta binário `llama-server` no PATH
- `/qwen-review:setup --provider=local --model=qwen2.5-coder-14b` faz download do GGUF se não existir
- Plugin spawn server quando hook fire, com keep-alive de N minutos
- Gerencia PID, port allocation, crash recovery

**Custo:** alto, bastante surface area pra bugs. **Benefício:** UX one-command. **Trade-off:** quebra zero-deps (precisa de `tar`/`curl`/file-mgmt), expande de "plugin de review" pra "infra runner". **Veredito:** out of scope.

### Opção D — Inference embutida (`node-llama-cpp`) ❌

- Pega `node-llama-cpp` npm package, embute inference direto no plugin
- Sem server, sem HTTP
- Adiciona npm dep pesada (binário nativo + bindings), quebra princípio zero-deps
- Cross-platform (build, prebuilt binaries) é problema

**Veredito:** não.

## Recomendação pra v0.2

1. **Implementar Opção B.** ~80 LOC + 6 tests + README section. Mantém a estética minimalista do plugin (zero deps, env-var driven).
2. **Doc do Opção A entra de qualquer jeito** (o caso "QWEN_PROVIDER=custom" continua sendo pointer pro endpoint OpenAI-compat que o usuário escolher).
3. **Adicionar warning em `deep` mode quando provider=local** — "`enable_thinking` é DashScope-specific; modo deep degrada para fast em provider local".
4. **Skip Opção C/D.** Plugin continua sendo orquestrador de review, não runner de inference.

## Mudanças concretas pra Opção B

### `lib/qwen-client.mjs`

```javascript
const MODE_DEFAULTS = {
  fast: { maxTokens: 1024, timeoutMs: 120_000, enableThinking: false },
  deep: { maxTokens: 8192, timeoutMs: 600_000, enableThinking: true }
};

const PROVIDER_DEFAULTS = {
  dashscope: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", needsAuth: true, supportsThinking: true },
  local:     { baseUrl: "http://127.0.0.1:8080/v1", needsAuth: false, supportsThinking: false, timeoutBoost: 2.5 },
  custom:    { needsAuth: true, supportsThinking: true }
};

export async function callQwen({ apiKey, baseUrl, model, prompt, mode = "fast", provider = "dashscope", overrides = {} }) {
  const provDef = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.custom;
  if (provDef.needsAuth && !apiKey) throw new Error("QWEN_API_KEY required");
  const url = `${(baseUrl ?? provDef.baseUrl).replace(/\/$/, "")}/chat/completions`;
  const params = resolveModeParams(mode, overrides);
  if (provDef.timeoutBoost) params.timeoutMs = Math.round(params.timeoutMs * provDef.timeoutBoost);

  const body = { model, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: params.maxTokens, stream: false };
  if (params.enableThinking && provDef.supportsThinking) body.extra_body = { enable_thinking: true };

  const headers = { "Content-Type": "application/json" };
  if (provDef.needsAuth) headers.Authorization = `Bearer ${apiKey}`;

  // ... rest unchanged
}
```

### `stop-review-hook.mjs` / `qwen-review.mjs`

```javascript
provider: (process.env.QWEN_PROVIDER || "dashscope").toLowerCase(),
```

### Novo teste (em `qwen-client.test.mjs`)

```javascript
test("local provider omits Authorization header", async () => {
  let captured;
  mockFetch((url, opts) => { captured = opts; return jsonResponse({ choices: [{ message: { content: "ALLOW: ok" } }] }); });
  await callQwen({ baseUrl: "http://127.0.0.1:8080/v1", model: "x", prompt: "p", provider: "local" });
  assert.equal(captured.headers.Authorization, undefined);
});

test("local provider drops extra_body.enable_thinking in deep mode", async () => {
  let captured;
  mockFetch((url, opts) => { captured = opts; return jsonResponse({ choices: [{ message: { content: "ALLOW: ok" } }] }); });
  await callQwen({ baseUrl: "http://127.0.0.1:8080/v1", model: "x", prompt: "p", mode: "deep", provider: "local" });
  const body = JSON.parse(captured.body);
  assert.equal(body.extra_body, undefined);
});

test("local provider doesn't require apiKey", async () => {
  // does not throw
  mockFetch(() => jsonResponse({ choices: [{ message: { content: "ALLOW: ok" } }] }));
  await callQwen({ baseUrl: "http://127.0.0.1:8080/v1", model: "x", prompt: "p", provider: "local" });
});
```

## Riscos / gotchas a documentar

1. **Memória:** GGUF Q4 32B precisa de ~24GB VRAM ou ~30GB RAM. Usuário sem hardware vai bater OOM.
2. **Cold start:** primeira chamada após `llama-server` startar pode levar 5-10s extras (warm-up do KV cache).
3. **Modelo errado para tarefa:** Qwen2.5-7B-Instruct (não-Coder) responde pior em review de código que a variante Coder.
4. **`extra_body` silenciosamente dropado:** se o usuário esperar comportamento `deep` igual ao DashScope, vai ter surpresa. Mensagem no `/qwen-review:setup --provider=local` deve avisar.
5. **Conflito de porta 8080:** comum (muito outro serviço usa). Doc deve mostrar `--port 11434` (porta padrão do Ollama, que também é OpenAI-compat e pode ser alternativa).

## Bonus: alternativa Ollama (~0 LOC)

`ollama serve` expõe `/v1/chat/completions` OpenAI-compat na porta 11434. Mesma estratégia que llama-server — Opção A já cobre. Pode valer mencionar:

```bash
ollama pull qwen2.5-coder:32b
ollama serve  # já rodando em background no install padrão
export QWEN_BASE_URL=http://localhost:11434/v1
export QWEN_MODEL=qwen2.5-coder:32b
export QWEN_API_KEY=ollama
```

Ollama é menos configurável que llama-server mas trivial de instalar. Bom mid-point.
