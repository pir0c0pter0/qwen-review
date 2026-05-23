# Qwen Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar plugin Claude Code que chama a API Qwen 3.7 Max como revisor crítico no hook `Stop`, podendo emitir `decision: "block"` para forçar Claude a corrigir antes de parar.

**Architecture:** Plugin Node ≥18 puro (zero deps npm) em `/var/home/mariostjr/Projetos/qwen-review/`. Hook `Stop` lê stdin do Claude Code, monta prompt com `last_assistant_message` + `git diff HEAD` + conteúdo dos arquivos modificados (todos pré-redactados de secrets), faz POST OpenAI-compat ao Qwen, parsa `ALLOW:`/`BLOCK:` e devolve decisão. State JSON por workspace controla on/off do gate.

**Tech Stack:** Node ≥18 (`fetch` nativo, `node:test` + `node:assert`, `AbortController`, `child_process.execSync`); contract de hook do Claude Code; endpoint OpenAI-compat (default DashScope international).

**Spec de referência:** [`../specs/2026-05-23-qwen-review-gate-design.md`](../specs/2026-05-23-qwen-review-gate-design.md)

---

## File Structure

Working dir: `/var/home/mariostjr/Projetos/qwen-review/` (já clonado, branch `main`, com spec dentro).

```
qwen-review/
├── .claude-plugin/plugin.json          # Task 0: metadata do plugin
├── .gitignore                          # Task 0: ignore node_modules (defensivo) e .qwen-review-debug.log
├── hooks/hooks.json                    # Task 9: registra Stop hook → stop-review-hook.mjs (timeout 660s)
├── commands/
│   ├── setup.md                        # Task 8: /qwen-review:setup [--enable|--disable]
│   ├── status.md                       # Task 8: /qwen-review:status
│   └── check.md                        # Task 8: /qwen-review:check [--diff-only]
├── prompts/stop-review.md              # Task 4: template com {{LAST_ASSISTANT}}, {{GIT_DIFF}}, {{CHANGED_FILES_CONTENT}}
├── scripts/
│   ├── stop-review-hook.mjs            # Task 6: entrada do hook Stop (orquestra tudo)
│   ├── qwen-review.mjs                 # Task 7: CLI multiplex (setup|status|check)
│   └── lib/
│       ├── workspace.mjs               # Task 1: resolveWorkspaceRoot (git root → cwd)
│       ├── config.mjs                  # Task 2: state.json por workspace
│       ├── redactor.mjs                # Task 3: pre-redaction de secrets (file skip + regex)
│       ├── prompt.mjs                  # Task 4: loadTemplate, interpolate, truncate
│       └── qwen-client.mjs             # Task 5: callQwen com modes fast/deep
├── test/
│   ├── workspace.test.mjs              # Task 1
│   ├── config.test.mjs                 # Task 2
│   ├── redactor.test.mjs               # Task 3
│   ├── prompt.test.mjs                 # Task 4
│   ├── qwen-client.test.mjs            # Task 5
│   ├── stop-hook.test.mjs              # Task 6 (mock global fetch)
│   └── helpers/
│       └── tempdir.mjs                 # Task 1: util compartilhado (cria/limpa tmp git repo)
├── README.md                           # Task 10: instalação, env vars, troubleshooting
├── docs/superpowers/specs/             # já existe (spec)
└── docs/superpowers/plans/             # este arquivo
```

**Princípios:**
- Cada `lib/*.mjs` é puro (sem side effects além de fs/exec explícitos). Hook e CLI orquestram.
- Testes mockam `global.fetch` para qwen-client e stop-hook; mockam `process.env` e tmpdir para config.
- Sem `package.json` — plugin é instalado por symlink/clone direto em `~/.claude/plugins/local/qwen-review/`.

## Pre-flight (uma vez, antes de começar)

- [ ] **Confirmar working dir:** `pwd` deve mostrar `/var/home/mariostjr/Projetos/qwen-review`. Se não, `cd` lá.
- [ ] **Confirmar branch:** `git status` deve mostrar `On branch main`, clean (só os 2 commits do spec).
- [ ] **Confirmar Node:** `node --version` deve ser ≥ v18. Spec usa `fetch` nativo, top-level await, `AbortController`.
- [ ] **Convenção de commit:** seguir o padrão dos commits existentes (Conventional Commits estilo livre, sem GPG signing — use `-c commit.gpgsign=false` se o ambiente tentar assinar).

---

## Task 0: Repo scaffold

Cria estrutura de diretórios, `plugin.json` mínimo e `.gitignore`. Nenhum código de runtime ainda — pasta vazia com placeholders pra próximo task encontrar lugar.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/.claude-plugin/plugin.json`
- Create: `/var/home/mariostjr/Projetos/qwen-review/.gitignore`
- Create directories (vazios por enquanto, com `.gitkeep`): `hooks/`, `commands/`, `prompts/`, `scripts/lib/`, `test/helpers/`

- [ ] **Step 1: Criar árvore de diretórios**

```bash
cd /var/home/mariostjr/Projetos/qwen-review
mkdir -p .claude-plugin hooks commands prompts scripts/lib test/helpers
```

- [ ] **Step 2: Criar plugin.json**

Path: `/var/home/mariostjr/Projetos/qwen-review/.claude-plugin/plugin.json`

```json
{
  "name": "qwen-review",
  "version": "0.1.0",
  "description": "Stop-time review gate via Qwen 3.7 Max API (OpenAI-compatible). Espelha o codex stop-review-gate.",
  "author": {
    "name": "Mario Junior"
  }
}
```

- [ ] **Step 3: Criar .gitignore**

Path: `/var/home/mariostjr/Projetos/qwen-review/.gitignore`

```
node_modules/
.qwen-review-debug.log
*.log
.DS_Store
```

- [ ] **Step 4: Criar .gitkeep nas pastas vazias** (mantém estrutura no git enquanto não tem código)

```bash
touch hooks/.gitkeep commands/.gitkeep prompts/.gitkeep scripts/lib/.gitkeep test/helpers/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/ .gitignore hooks/ commands/ prompts/ scripts/ test/
git -c commit.gpgsign=false commit -m "chore: scaffold plugin directory structure

Create plugin.json (v0.1.0), .gitignore, and placeholder directories
for hooks/, commands/, prompts/, scripts/lib/, test/helpers/."
```

---

## Task 1: `lib/workspace.mjs` — resolveWorkspaceRoot + tempdir test helper

Resolve a raiz do workspace: prefere `git rev-parse --show-toplevel`, cai pro `cwd` absoluto se não estiver num repo. Test helper `tempdir.mjs` cria um repo git temporário pra outros testes reutilizarem.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/workspace.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/workspace.test.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/helpers/tempdir.mjs`

- [ ] **Step 1: Escrever o test helper `tempdir.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/helpers/tempdir.mjs`

```javascript
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-review-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execSync("git add .gitkeep", { cwd: dir });
  execSync('git -c commit.gpgsign=false commit -q -m "init"', { cwd: dir });
  return dir;
}

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-review-test-"));
}

export function cleanup(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Escrever os testes que vão falhar**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/workspace.test.mjs`

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";

test("resolveWorkspaceRoot returns git toplevel when inside a repo", () => {
  const repo = makeTempGitRepo();
  try {
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const root = resolveWorkspaceRoot(sub);
    assert.equal(fs.realpathSync(root), fs.realpathSync(repo));
  } finally {
    cleanup(repo);
  }
});

test("resolveWorkspaceRoot falls back to absolute cwd when outside a repo", () => {
  const tmp = makeTempDir();
  try {
    const root = resolveWorkspaceRoot(tmp);
    assert.equal(root, path.resolve(tmp));
  } finally {
    cleanup(tmp);
  }
});
```

- [ ] **Step 3: Rodar pra confirmar que falha**

```bash
cd /var/home/mariostjr/Projetos/qwen-review
node --test test/workspace.test.mjs
```

Expected: FAIL com `ERR_MODULE_NOT_FOUND` apontando pra `scripts/lib/workspace.mjs`.

- [ ] **Step 4: Implementar `workspace.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/workspace.mjs`

```javascript
import { execSync } from "node:child_process";
import path from "node:path";

export function resolveWorkspaceRoot(cwd) {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (root) return root;
  } catch {
    // not a git repo
  }
  return path.resolve(cwd);
}
```

- [ ] **Step 5: Rodar e confirmar PASS**

```bash
node --test test/workspace.test.mjs
```

Expected: 2 tests passed.

- [ ] **Step 6: Apagar `scripts/lib/.gitkeep` e `test/helpers/.gitkeep`** (não precisamos mais — as pastas agora têm arquivos reais)

```bash
rm scripts/lib/.gitkeep test/helpers/.gitkeep
```

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/workspace.mjs test/workspace.test.mjs test/helpers/tempdir.mjs
git rm scripts/lib/.gitkeep test/helpers/.gitkeep
git -c commit.gpgsign=false commit -m "feat(workspace): add resolveWorkspaceRoot

Returns git toplevel when inside a repo, falls back to absolute cwd
otherwise. Tests use real tmp git repo via shared tempdir helper."
```

---

## Task 2: `lib/config.mjs` — state.json por workspace

Persistência por workspace seguindo o padrão do codex (slug + sha256 do realpath). Read/write atômico, default state com `stopReviewGate: false` e `lastReview: null`, perms `0o600` no arquivo.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/config.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/config.test.mjs`

- [ ] **Step 1: Escrever os testes**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/config.test.mjs`

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loadState,
  saveState,
  getConfig,
  setConfig,
  saveLastReview,
  resolveStateDir,
  resolveStateFile
} from "../scripts/lib/config.mjs";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";

function withPluginData(fn) {
  const data = makeTempDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    return fn(data);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    cleanup(data);
  }
}

test("loadState returns defaults when no state file exists", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      const state = loadState(repo);
      assert.equal(state.version, 1);
      assert.equal(state.config.stopReviewGate, false);
      assert.equal(state.lastReview, null);
    } finally {
      cleanup(repo);
    }
  });
});

test("setConfig + getConfig round-trip", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      setConfig(repo, "stopReviewGate", true);
      assert.equal(getConfig(repo).stopReviewGate, true);
    } finally {
      cleanup(repo);
    }
  });
});

test("saveLastReview persists metadata", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      saveLastReview(repo, {
        ts: "2026-05-23T00:00:00Z",
        decision: "block",
        reason: "test",
        model: "qwen3-max",
        latencyMs: 1234
      });
      const state = loadState(repo);
      assert.equal(state.lastReview.decision, "block");
      assert.equal(state.lastReview.latencyMs, 1234);
    } finally {
      cleanup(repo);
    }
  });
});

test("state files for different workspaces do not collide", () => {
  withPluginData(() => {
    const a = makeTempGitRepo();
    const b = makeTempGitRepo();
    try {
      setConfig(a, "stopReviewGate", true);
      setConfig(b, "stopReviewGate", false);
      assert.equal(getConfig(a).stopReviewGate, true);
      assert.equal(getConfig(b).stopReviewGate, false);
      assert.notEqual(resolveStateDir(a), resolveStateDir(b));
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });
});

test("state file is created with 0o600 perms", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      setConfig(repo, "stopReviewGate", true);
      const file = resolveStateFile(repo);
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      cleanup(repo);
    }
  });
});

test("corrupted state file falls back to defaults", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      const file = resolveStateFile(repo);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "not json{{{", { mode: 0o600 });
      const state = loadState(repo);
      assert.equal(state.config.stopReviewGate, false);
    } finally {
      cleanup(repo);
    }
  });
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

```bash
node --test test/config.test.mjs
```

Expected: FAIL com `ERR_MODULE_NOT_FOUND` apontando pra `scripts/lib/config.mjs`.

- [ ] **Step 3: Implementar `config.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/config.mjs`

```javascript
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "qwen-review");
const STATE_FILE_NAME = "state.json";

function defaultState() {
  return {
    version: STATE_VERSION,
    config: { stopReviewGate: false },
    lastReview: null
  };
}

export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {
    canonical = root;
  }
  const slugSource = path.basename(root) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const base = process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT;
  return path.join(base, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config ?? {}) }
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const file = resolveStateFile(cwd);
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  return state;
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, key, value) {
  const state = loadState(cwd);
  state.config = { ...state.config, [key]: value };
  return saveState(cwd, state);
}

export function saveLastReview(cwd, lastReview) {
  const state = loadState(cwd);
  state.lastReview = lastReview;
  return saveState(cwd, state);
}
```

- [ ] **Step 4: Rodar e confirmar PASS**

```bash
node --test test/config.test.mjs
```

Expected: 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/config.mjs test/config.test.mjs
git -c commit.gpgsign=false commit -m "feat(config): add per-workspace state.json with 0o600 perms

State dir is \${CLAUDE_PLUGIN_DATA}/state/<slug>-<sha256(realpath)[16]>/
to keep gate config isolated between workspaces. Defaults: gate off,
no lastReview. Corrupted JSON falls back to defaults silently."
```

---

## Task 3: `lib/redactor.mjs` — pre-redaction de secrets

Implementa file-level skip e content-level regex conforme §5.2 do spec. Esta é a barreira que impede vazamento de credenciais pro provider HTTP.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/redactor.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/redactor.test.mjs`

- [ ] **Step 1: Escrever os testes**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/redactor.test.mjs`

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, shouldSkipFile, isBinary } from "../scripts/lib/redactor.mjs";

test("redactSecrets masks AWS access key", () => {
  const input = "key = AKIAIOSFODNN7EXAMPLE end";
  assert.equal(redactSecrets(input), "key = [REDACTED:aws-access-key] end");
});

test("redactSecrets masks OpenAI / Qwen style sk- key", () => {
  const input = "Bearer sk-1234567890abcdefghij1234567890ABCD";
  assert.match(redactSecrets(input), /\[REDACTED:openai-or-qwen-key\]/);
});

test("redactSecrets masks GitHub token", () => {
  const input = "token=ghp_1234567890abcdefghijABCDEFGHIJ";
  assert.match(redactSecrets(input), /\[REDACTED:github-token\]/);
});

test("redactSecrets masks JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.match(redactSecrets(`auth: ${jwt}`), /\[REDACTED:jwt\]/);
});

test("redactSecrets masks PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactSecrets(pem), "[REDACTED:pem]");
});

test("redactSecrets masks Slack token", () => {
  const input = "xoxb-1234567890-abcdefghij";
  assert.match(redactSecrets(input), /\[REDACTED:slack-token\]/);
});

test("redactSecrets is a no-op on plain text", () => {
  assert.equal(redactSecrets("hello world\nplain text"), "hello world\nplain text");
});

test("redactSecrets handles empty / null inputs", () => {
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});

test("shouldSkipFile skips .env and friends", () => {
  assert.equal(shouldSkipFile(".env"), true);
  assert.equal(shouldSkipFile(".env.local"), true);
  assert.equal(shouldSkipFile(".env.production"), true);
  assert.equal(shouldSkipFile("src/.env"), true);
});

test("shouldSkipFile skips key/pem/crt files", () => {
  assert.equal(shouldSkipFile("certs/server.key"), true);
  assert.equal(shouldSkipFile("ca.pem"), true);
  assert.equal(shouldSkipFile("client.crt"), true);
  assert.equal(shouldSkipFile("store.p12"), true);
});

test("shouldSkipFile skips ssh private keys", () => {
  assert.equal(shouldSkipFile("home/user/.ssh/id_rsa"), true);
  assert.equal(shouldSkipFile(".ssh/id_ed25519"), true);
});

test("shouldSkipFile skips paths containing secret/credential/token", () => {
  assert.equal(shouldSkipFile("config/secrets.yaml"), true);
  assert.equal(shouldSkipFile("Credentials.json"), true);
  assert.equal(shouldSkipFile("auth/tokens.ts"), true);
});

test("shouldSkipFile does not skip normal source files", () => {
  assert.equal(shouldSkipFile("src/index.ts"), false);
  assert.equal(shouldSkipFile("README.md"), false);
  assert.equal(shouldSkipFile("package.json"), false);
});

test("shouldSkipFile respects user-provided extra globs", () => {
  assert.equal(shouldSkipFile("data/private.csv", ["data/*.csv"]), true);
  assert.equal(shouldSkipFile("src/index.ts", ["data/*.csv"]), false);
});

test("isBinary detects null byte in first 8KB", () => {
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  assert.equal(isBinary(bin), true);
});

test("isBinary returns false for utf8 text", () => {
  const txt = Buffer.from("hello\nworld\n", "utf8");
  assert.equal(isBinary(txt), false);
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

```bash
node --test test/redactor.test.mjs
```

Expected: FAIL com `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implementar `redactor.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/redactor.mjs`

```javascript
const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-access-key]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:openai-or-qwen-key]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    "[REDACTED:jwt]"
  ],
  [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    "[REDACTED:pem]"
  ],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"]
];

const DEFAULT_SKIP_PATTERNS = [
  /(^|\/)\.env($|\.[^/]+$)/,
  /\.(key|pem|crt|p12|pfx|jks)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(secret|credential|token)/i
];

function globToRegex(glob) {
  // Escape regex specials, then translate ** → .*, * → [^/]*
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp("^" + escaped + "$");
}

export function shouldSkipFile(filePath, extraGlobs = []) {
  const normalized = String(filePath).replace(/\\/g, "/");
  for (const re of DEFAULT_SKIP_PATTERNS) {
    if (re.test(normalized)) return true;
  }
  for (const glob of extraGlobs) {
    if (!glob) continue;
    if (globToRegex(glob).test(normalized)) return true;
  }
  return false;
}

export function isBinary(buffer, scanBytes = 8192) {
  if (!Buffer.isBuffer(buffer)) return false;
  const limit = Math.min(buffer.length, scanBytes);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function redactSecrets(text) {
  if (text === null || text === undefined || text === "") return text;
  let out = String(text);
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
```

- [ ] **Step 4: Rodar e confirmar PASS**

```bash
node --test test/redactor.test.mjs
```

Expected: 16 tests passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/redactor.mjs test/redactor.test.mjs
git -c commit.gpgsign=false commit -m "feat(redactor): add file-skip + regex secret redaction

Per spec §5.2: skip .env/.key/.pem/secret/credential/token paths and
binaries; mask AWS/OpenAI/GitHub/JWT/PEM/Slack tokens in remaining
content. User-provided globs extend the skip list. Defense layer
against credential exfiltration to the Qwen provider."
```

---

## Task 4: `lib/prompt.mjs` + `prompts/stop-review.md` template

Loader/interpolator do template + truncamento configurável. Template é o do spec §5.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/prompts/stop-review.md`
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/prompt.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/prompt.test.mjs`

- [ ] **Step 1: Criar o template `prompts/stop-review.md`**

Path: `/var/home/mariostjr/Projetos/qwen-review/prompts/stop-review.md`

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

- [ ] **Step 2: Apagar `prompts/.gitkeep`**

```bash
rm prompts/.gitkeep
```

- [ ] **Step 3: Escrever os testes**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/prompt.test.mjs`

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplate, interpolate, truncate } from "../scripts/lib/prompt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

test("loadTemplate reads from <root>/prompts/<name>.md", () => {
  const text = loadTemplate(ROOT_DIR, "stop-review");
  assert.match(text, /<previous_assistant_message>/);
  assert.match(text, /\{\{LAST_ASSISTANT\}\}/);
  assert.match(text, /\{\{GIT_DIFF\}\}/);
  assert.match(text, /\{\{CHANGED_FILES_CONTENT\}\}/);
});

test("interpolate replaces {{VAR}} tokens", () => {
  const out = interpolate("hello {{NAME}}!", { NAME: "world" });
  assert.equal(out, "hello world!");
});

test("interpolate replaces missing vars with empty string", () => {
  const out = interpolate("a={{A}} b={{B}}", { A: "x" });
  assert.equal(out, "a=x b=");
});

test("interpolate handles multi-line values", () => {
  const out = interpolate("<x>{{X}}</x>", { X: "line1\nline2" });
  assert.equal(out, "<x>line1\nline2</x>");
});

test("truncate returns text unchanged when within budget", () => {
  assert.equal(truncate("short", 100, 100), "short");
});

test("truncate with head + tail keeps both ends", () => {
  const input = "a".repeat(10) + "MIDDLE" + "b".repeat(10);
  const out = truncate(input, 5, 5);
  assert.match(out, /^aaaaa/);
  assert.match(out, /bbbbb$/);
  assert.match(out, /\[…truncated…\]/);
});

test("truncate with tail=0 keeps only the head", () => {
  const input = "a".repeat(100);
  const out = truncate(input, 10);
  assert.equal(out.startsWith("a".repeat(10)), true);
  assert.match(out, /\[…truncated…\]$/);
});

test("truncate handles empty/null", () => {
  assert.equal(truncate("", 10, 10), "");
  assert.equal(truncate(null, 10, 10), null);
});
```

- [ ] **Step 4: Rodar pra confirmar que falha**

```bash
node --test test/prompt.test.mjs
```

Expected: FAIL — `prompt.mjs` ainda não existe.

- [ ] **Step 5: Implementar `prompt.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/prompt.mjs`

```javascript
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TRUNCATE_MARKER = "[…truncated…]";

export function loadTemplate(rootDir, name) {
  return fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
}

export function interpolate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars?.[key];
    return val === undefined || val === null ? "" : String(val);
  });
}

export function truncate(text, head, tail = 0, marker = DEFAULT_TRUNCATE_MARKER) {
  if (text === null || text === undefined) return text;
  const str = String(text);
  if (str.length <= head + tail) return str;
  if (tail === 0) return str.slice(0, head) + "\n" + marker;
  return str.slice(0, head) + "\n" + marker + "\n" + str.slice(-tail);
}
```

- [ ] **Step 6: Rodar e confirmar PASS**

```bash
node --test test/prompt.test.mjs
```

Expected: 8 tests passed.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/prompt.mjs test/prompt.test.mjs prompts/stop-review.md
git rm prompts/.gitkeep
git -c commit.gpgsign=false commit -m "feat(prompt): add template loader, interpolator, truncator

prompts/stop-review.md is the v0.1 template (per spec §5) with three
interpolation vars: LAST_ASSISTANT, GIT_DIFF, CHANGED_FILES_CONTENT.
truncate() supports head-only or head+tail with truncation marker."
```

---

## Task 5: `lib/qwen-client.mjs` — fetch + modos fast/deep

Single-shot POST OpenAI-compat, com modos `fast` (default) e `deep` (thinking + 8192 tokens + 600s timeout). Mock fetch nos tests pra validar request body, headers, timeout.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/qwen-client.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/qwen-client.test.mjs`

- [ ] **Step 1: Escrever os testes**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/qwen-client.test.mjs`

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { callQwen, resolveModeParams } from "../scripts/lib/qwen-client.mjs";

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

test("resolveModeParams returns fast defaults", () => {
  const p = resolveModeParams("fast");
  assert.equal(p.maxTokens, 1024);
  assert.equal(p.timeoutMs, 120_000);
  assert.equal(p.enableThinking, false);
});

test("resolveModeParams returns deep defaults", () => {
  const p = resolveModeParams("deep");
  assert.equal(p.maxTokens, 8192);
  assert.equal(p.timeoutMs, 600_000);
  assert.equal(p.enableThinking, true);
});

test("resolveModeParams unknown mode falls back to fast", () => {
  const p = resolveModeParams("bogus");
  assert.equal(p.maxTokens, 1024);
});

test("resolveModeParams overrides win", () => {
  const p = resolveModeParams("fast", { maxTokens: 42, timeoutMs: 5 });
  assert.equal(p.maxTokens, 42);
  assert.equal(p.timeoutMs, 5);
  assert.equal(p.enableThinking, false);
});

test("callQwen sends bearer auth and correct body shape (fast mode)", async () => {
  let captured;
  const restore = mockFetch(async (url, opts) => {
    captured = { url, opts };
    return jsonResponse({
      choices: [{ message: { content: "ALLOW: looks good" } }],
      usage: { prompt_tokens: 100, completion_tokens: 5 }
    });
  });
  try {
    const result = await callQwen({
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
      model: "qwen3-max",
      prompt: "review please"
    });
    assert.equal(captured.url, "https://example.test/v1/chat/completions");
    assert.equal(captured.opts.method, "POST");
    assert.equal(captured.opts.headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, "qwen3-max");
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.messages[0].content, "review please");
    assert.equal(body.extra_body, undefined); // not set in fast
    assert.equal(result.content, "ALLOW: looks good");
    assert.equal(result.usage.prompt_tokens, 100);
    assert.equal(typeof result.latencyMs, "number");
  } finally {
    restore();
  }
});

test("callQwen deep mode sets extra_body.enable_thinking", async () => {
  let captured;
  const restore = mockFetch(async (url, opts) => {
    captured = opts;
    return jsonResponse({ choices: [{ message: { content: "ALLOW: deep" } }] });
  });
  try {
    await callQwen({
      apiKey: "sk-x",
      baseUrl: "https://example.test/v1",
      model: "qwen3-max",
      prompt: "x",
      mode: "deep"
    });
    const body = JSON.parse(captured.body);
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.extra_body, { enable_thinking: true });
  } finally {
    restore();
  }
});

test("callQwen strips trailing slash from baseUrl", async () => {
  let captured;
  const restore = mockFetch(async (url) => {
    captured = url;
    return jsonResponse({ choices: [{ message: { content: "ALLOW" } }] });
  });
  try {
    await callQwen({
      apiKey: "k",
      baseUrl: "https://example.test/v1/",
      model: "qwen3-max",
      prompt: "x"
    });
    assert.equal(captured, "https://example.test/v1/chat/completions");
  } finally {
    restore();
  }
});

test("callQwen throws on HTTP 401 with body excerpt", async () => {
  const restore = mockFetch(async () =>
    new Response("Invalid API key", { status: 401 })
  );
  try {
    await assert.rejects(
      () => callQwen({
        apiKey: "bad",
        baseUrl: "https://example.test/v1",
        model: "qwen3-max",
        prompt: "x"
      }),
      /Qwen API 401: Invalid API key/
    );
  } finally {
    restore();
  }
});

test("callQwen throws when apiKey missing", async () => {
  await assert.rejects(
    () => callQwen({
      baseUrl: "https://example.test/v1",
      model: "qwen3-max",
      prompt: "x"
    }),
    /QWEN_API_KEY required/
  );
});

test("callQwen aborts via AbortController on timeout", async () => {
  const restore = mockFetch(async (url, opts) => {
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
  try {
    await assert.rejects(
      () => callQwen({
        apiKey: "k",
        baseUrl: "https://example.test/v1",
        model: "qwen3-max",
        prompt: "x",
        overrides: { timeoutMs: 25 }
      }),
      /aborted/i
    );
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Rodar pra confirmar que falha**

```bash
node --test test/qwen-client.test.mjs
```

Expected: FAIL — `qwen-client.mjs` ainda não existe.

- [ ] **Step 3: Implementar `qwen-client.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/lib/qwen-client.mjs`

```javascript
const MODE_DEFAULTS = {
  fast: { maxTokens: 1024, timeoutMs: 120_000, enableThinking: false },
  deep: { maxTokens: 8192, timeoutMs: 600_000, enableThinking: true }
};

export function resolveModeParams(mode = "fast", overrides = {}) {
  const base = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.fast;
  return { ...base, ...overrides };
}

export async function callQwen({
  apiKey,
  baseUrl,
  model,
  prompt,
  mode = "fast",
  overrides = {}
}) {
  if (!apiKey) throw new Error("QWEN_API_KEY required");
  const params = resolveModeParams(mode, overrides);
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
  const url = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Qwen API ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return {
      content: data?.choices?.[0]?.message?.content ?? "",
      usage: data?.usage ?? {},
      latencyMs
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Rodar e confirmar PASS**

```bash
node --test test/qwen-client.test.mjs
```

Expected: 10 tests passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/qwen-client.mjs test/qwen-client.test.mjs
git -c commit.gpgsign=false commit -m "feat(qwen-client): single-shot OpenAI-compat POST with fast/deep modes

fast: max_tokens 1024, timeout 120s, no thinking.
deep: max_tokens 8192, timeout 600s, extra_body.enable_thinking=true.
AbortController enforces timeout. Bearer auth via QWEN_API_KEY.
Returns {content, usage, latencyMs}."
```

---

## Task 6: `scripts/stop-review-hook.mjs` — orquestrador do hook Stop

Junta tudo: lê stdin do hook, valida config + env, monta prompt com redaction, chama Qwen, parsa decisão, emite block JSON ou exit 0. Fail-open em qualquer erro inesperado. Persiste `lastReview` no state.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/stop-review-hook.mjs`
- Create: `/var/home/mariostjr/Projetos/qwen-review/test/stop-hook.test.mjs`

- [ ] **Step 1: Escrever os testes end-to-end** (mock global.fetch e usa tmp git repo)

Path: `/var/home/mariostjr/Projetos/qwen-review/test/stop-hook.test.mjs`

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT_DIR, "scripts", "stop-review-hook.mjs");

// Runs the hook as a child process with stdin JSON and env overrides.
function runHook({ cwd, input = {}, env = {}, mockResponse }) {
  // Mock fetch via a tiny harness: child writes the mock URL/response into the env,
  // and we run an inline preload that overrides global.fetch before importing the hook.
  const preload = path.join(ROOT_DIR, "test", "helpers", "mock-fetch-preload.mjs");
  if (mockResponse !== undefined) {
    fs.writeFileSync(
      path.join(env.MOCK_DIR ?? makeTempDir(), "_unused"),
      ""
    );
  }
  const result = spawnSync(
    process.execPath,
    ["--import", preload, HOOK],
    {
      cwd,
      input: JSON.stringify(input),
      env: {
        ...process.env,
        ...env,
        MOCK_RESPONSE: mockResponse ? JSON.stringify(mockResponse) : ""
      },
      encoding: "utf8"
    }
  );
  return result;
}

test("hook is silent when gate is off", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "x" },
      input: { cwd: repo, last_assistant_message: "hi", session_id: "s" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook skips with stderr note when QWEN_API_KEY missing", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    // enable gate
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "" },
      input: { cwd: repo, last_assistant_message: "hi", session_id: "s" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /QWEN_API_KEY not set/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook emits block when Qwen returns BLOCK:", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    // Force a diff so the shortcut path doesn't trigger
    fs.writeFileSync(path.join(repo, "x.js"), "function f() { return undefiend; }\n");
    execSync("git add x.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: {
        cwd: repo,
        last_assistant_message: "added function f",
        session_id: "s"
      },
      mockResponse: {
        status: 200,
        body: {
          choices: [{ message: { content: "BLOCK: typo undefiend in x.js:1" } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 }
        }
      }
    });
    assert.equal(r.status, 0);
    const decision = JSON.parse(r.stdout.trim());
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /typo undefiend/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook is silent when Qwen returns ALLOW:", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "y.js"), "export const x = 1;\n");
    execSync("git add y.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "trivial change", session_id: "s" },
      mockResponse: {
        status: 200,
        body: { choices: [{ message: { content: "ALLOW: trivial" } }] }
      }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook fails open on HTTP 500", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "z.js"), "x\n");
    execSync("git add z.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "y", session_id: "s" },
      mockResponse: { status: 503, body: "upstream down" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /503/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook fails open on response with no ALLOW/BLOCK prefix", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "q.js"), "x\n");
    execSync("git add q.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "y", session_id: "s" },
      mockResponse: {
        status: 200,
        body: { choices: [{ message: { content: "I think this is fine" } }] }
      }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /unexpected response shape/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook skips API call when assistant message and diff are both empty", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "", session_id: "s" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook reviews UNTRACKED new files (not shortcut-skipped, included in prompt)", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    // Create a new file WITHOUT git add — simulates Claude using Write tool
    fs.writeFileSync(
      path.join(repo, "broken.js"),
      "function broken() { return undefiend; }\n"
    );
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        CAPTURE_FILE: captureFile
      },
      input: {
        cwd: repo,
        last_assistant_message: "created broken.js",
        session_id: "s"
      },
      mockResponse: {
        status: 200,
        body: {
          choices: [{ message: { content: "BLOCK: typo undefiend in broken.js:1" } }]
        }
      }
    });
    assert.equal(r.status, 0);
    const decision = JSON.parse(r.stdout.trim());
    assert.equal(decision.decision, "block");
    // Verify the new file content actually reached the prompt
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const sent = JSON.parse(captured.opts.body).messages[0].content;
    assert.match(sent, /broken\.js/);
    assert.match(sent, /undefiend/);
    // Synthetic diff format: "new file mode" header from git diff --no-index
    assert.match(sent, /new file mode|\+function broken/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});

test("hook excludes UNTRACKED .env from diff body (no secret leak)", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    // Add one real source change so the hook proceeds
    fs.writeFileSync(path.join(repo, "src.js"), "export const x = 1;\n");
    execSync("git add src.js", { cwd: repo });
    // Untracked .env with a non-pattern-matching secret (so file-skip is the only protection)
    fs.writeFileSync(
      path.join(repo, ".env"),
      "DATABASE_URL=postgres://u:p@host/db\nINTERNAL_PASSWORD=hunter2-not-a-known-token-pattern\n"
    );
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        CAPTURE_FILE: captureFile
      },
      input: { cwd: repo, last_assistant_message: "touched src.js and added .env", session_id: "s" },
      mockResponse: { status: 200, body: { choices: [{ message: { content: "ALLOW: ok" } }] } }
    });
    assert.equal(r.status, 0);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const sent = JSON.parse(captured.opts.body).messages[0].content;
    // Skip placeholder appears
    assert.match(sent, /\[diff excluded: sensitive path\]/);
    assert.match(sent, /\[file excluded: sensitive path\]/);
    // Secret literals are NOT in the prompt
    assert.doesNotMatch(sent, /hunter2-not-a-known-token-pattern/);
    assert.doesNotMatch(sent, /DATABASE_URL=postgres/);
    // Normal source file still made it through
    assert.match(sent, /src\.js/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});

test("hook redacts sk- key in last_assistant_message before sending", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "f.js"), "x\n");
    execSync("git add f.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        CAPTURE_FILE: captureFile
      },
      input: {
        cwd: repo,
        last_assistant_message: "I used sk-abcdefghij1234567890abcdefghij1234 for auth",
        session_id: "s"
      },
      mockResponse: {
        status: 200,
        body: { choices: [{ message: { content: "ALLOW: ok" } }] }
      }
    });
    assert.equal(r.status, 0);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const body = JSON.parse(captured.opts.body);
    const sent = body.messages[0].content;
    assert.match(sent, /\[REDACTED:openai-or-qwen-key\]/);
    assert.doesNotMatch(sent, /sk-abcdefghij/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});
```

- [ ] **Step 2: Escrever o mock-fetch preload helper**

Path: `/var/home/mariostjr/Projetos/qwen-review/test/helpers/mock-fetch-preload.mjs`

```javascript
import fs from "node:fs";

const raw = process.env.MOCK_RESPONSE;
const captureFile = process.env.CAPTURE_FILE;

if (raw) {
  const spec = JSON.parse(raw);
  globalThis.fetch = async (url, opts) => {
    if (captureFile) {
      fs.writeFileSync(captureFile, JSON.stringify({ url, opts }, null, 2));
    }
    const status = spec.status ?? 200;
    const body = spec.body;
    const bodyStr =
      typeof body === "string" || body === undefined || body === null
        ? String(body ?? "")
        : JSON.stringify(body);
    return new Response(bodyStr, {
      status,
      headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" }
    });
  };
}
```

- [ ] **Step 3: Rodar pra confirmar que falha**

```bash
node --test test/stop-hook.test.mjs
```

Expected: FAIL — `scripts/stop-review-hook.mjs` ainda não existe.

- [ ] **Step 4: Implementar `stop-review-hook.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/stop-review-hook.mjs`

```javascript
#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { getConfig, saveLastReview } from "./lib/config.mjs";
import { loadTemplate, interpolate, truncate } from "./lib/prompt.mjs";
import { redactSecrets, shouldSkipFile, isBinary } from "./lib/redactor.mjs";
import { callQwen } from "./lib/qwen-client.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

const TOTAL_FILES_CAP = 16_000;
const PER_FILE_CAP = 4_000;
const LAST_ASSISTANT_HEAD = 4_000;
const LAST_ASSISTANT_TAIL = 4_000;
const DIFF_HEAD = 12_000;

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function logNote(msg) {
  if (msg) process.stderr.write(`qwen-review: ${msg}\n`);
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

function untrackedFiles(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function trackedChangedFiles(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "HEAD", "--name-only", "--diff-filter=ACMRT"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function trackedDiffForFile(cwd, file) {
  try {
    return execFileSync(
      "git",
      ["diff", "HEAD", "--no-color", "--", file],
      { cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return "";
  }
}

function syntheticDiffForUntracked(cwd, file) {
  // `git diff --no-index` returns exit 1 when files differ; capture stdout from err.
  try {
    return execFileSync(
      "git",
      ["diff", "--no-index", "--no-color", "/dev/null", file],
      { cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (err) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

// Per-file iteration so we can filter sensitive paths BEFORE the diff body is generated.
// Without this, `git diff HEAD` would dump full `.env` contents (and `git diff --no-index`
// would dump the entire new untracked file body) before redaction had any chance.
function gitDiff(cwd, extraGlobs = []) {
  const parts = [];
  for (const file of trackedChangedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\n[diff excluded: sensitive path]`);
      continue;
    }
    const d = trackedDiffForFile(cwd, file);
    if (d) parts.push(d);
  }
  for (const file of untrackedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\nnew file\n[diff excluded: sensitive path]`);
      continue;
    }
    const d = syntheticDiffForUntracked(cwd, file);
    if (d) parts.push(d);
  }
  return parts.filter(Boolean).join("\n");
}

function changedFiles(cwd) {
  return [...trackedChangedFiles(cwd), ...untrackedFiles(cwd)];
}

function buildChangedFilesContent(cwd, { redactEnabled, extraGlobs, maxFiles }) {
  const files = changedFiles(cwd);
  if (files.length === 0) return "";

  const blocks = [];
  let count = 0;
  let totalChars = 0;
  let omitted = 0;

  for (const file of files) {
    if (count >= maxFiles) { omitted = files.length - count; break; }

    if (shouldSkipFile(file, extraGlobs)) {
      blocks.push(`=== ${file} ===\n[file excluded: sensitive path]`);
      count++;
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(path.join(cwd, file));
    } catch {
      // file was deleted between diff and read; skip
      continue;
    }

    if (isBinary(buf)) {
      blocks.push(`=== ${file} ===\n[file excluded: binary]`);
      count++;
      continue;
    }

    let content = buf.toString("utf8");
    if (redactEnabled) content = redactSecrets(content);
    if (content.length > PER_FILE_CAP) {
      content = content.slice(0, PER_FILE_CAP) + "\n[truncated]";
    }
    const block = `=== ${file} ===\n${content}`;
    if (totalChars + block.length > TOTAL_FILES_CAP) {
      omitted = files.length - count;
      break;
    }
    blocks.push(block);
    totalChars += block.length;
    count++;
  }

  let out = blocks.join("\n\n");
  if (omitted > 0) out += `\n\n[${omitted} arquivos adicionais omitidos]`;
  return out;
}

function parseDecision(text) {
  const first = String(text ?? "").split(/\r?\n/, 1)[0].trim();
  if (first.startsWith("ALLOW:")) {
    return { allow: true, reason: first.slice("ALLOW:".length).trim() };
  }
  if (first.startsWith("BLOCK:")) {
    return { allow: false, reason: first.slice("BLOCK:".length).trim() };
  }
  return null;
}

function readEnvConfig() {
  const overrides = {};
  if (process.env.QWEN_REVIEW_MAX_TOKENS) {
    overrides.maxTokens = Number(process.env.QWEN_REVIEW_MAX_TOKENS);
  }
  if (process.env.QWEN_REVIEW_TIMEOUT_MS) {
    overrides.timeoutMs = Number(process.env.QWEN_REVIEW_TIMEOUT_MS);
  }
  return {
    apiKey: process.env.QWEN_API_KEY,
    baseUrl:
      process.env.QWEN_BASE_URL ||
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL || "qwen3-max",
    mode: process.env.QWEN_REVIEW_MODE === "deep" ? "deep" : "fast",
    maxFiles: Number(process.env.QWEN_REVIEW_MAX_FILES) || 5,
    redactEnabled: process.env.QWEN_REVIEW_REDACT_SECRETS !== "0",
    extraGlobs: (process.env.QWEN_REVIEW_EXCLUDE_GLOBS || "")
      .split(":")
      .filter(Boolean),
    overrides
  };
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const cfg = getConfig(workspaceRoot);

  if (!cfg.stopReviewGate) return;

  const env = readEnvConfig();
  if (!env.apiKey) {
    logNote("QWEN_API_KEY not set; gate skipped. Run /qwen-review:setup.");
    return;
  }

  const lastAssistant = String(input.last_assistant_message ?? "");
  const diff = gitDiff(workspaceRoot, env.extraGlobs);
  if (!lastAssistant.trim() && !diff.trim()) return;

  const truncatedLast = truncate(lastAssistant, LAST_ASSISTANT_HEAD, LAST_ASSISTANT_TAIL);
  const truncatedDiff = truncate(diff, DIFF_HEAD);
  const filesContent = buildChangedFilesContent(workspaceRoot, env);

  const vars = {
    LAST_ASSISTANT: env.redactEnabled ? redactSecrets(truncatedLast) : truncatedLast,
    GIT_DIFF: env.redactEnabled ? redactSecrets(truncatedDiff) : truncatedDiff,
    CHANGED_FILES_CONTENT: filesContent
  };

  const template = loadTemplate(ROOT_DIR, "stop-review");
  const prompt = interpolate(template, vars);

  let result;
  try {
    result = await callQwen({
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      model: env.model,
      prompt,
      mode: env.mode,
      overrides: env.overrides
    });
  } catch (err) {
    logNote(`API error: ${err.message || err}`);
    return;
  }

  if (process.env.QWEN_REVIEW_DEBUG === "1") {
    fs.writeFileSync(
      path.join(workspaceRoot, ".qwen-review-debug.log"),
      `=== prompt ===\n${prompt}\n\n=== response ===\n${result.content}\n`,
      "utf8"
    );
  }

  const decision = parseDecision(result.content);
  if (!decision) {
    logNote("unexpected response shape; gate skipped.");
    return;
  }

  try {
    saveLastReview(workspaceRoot, {
      ts: new Date().toISOString(),
      decision: decision.allow ? "allow" : "block",
      reason: decision.reason,
      model: env.model,
      mode: env.mode,
      latencyMs: result.latencyMs,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens
    });
  } catch (err) {
    logNote(`could not persist lastReview: ${err.message || err}`);
  }

  if (!decision.allow) {
    emitBlock(`Qwen review found issues: ${decision.reason}`);
  }
}

main().catch((err) => {
  process.stderr.write(`qwen-review: ${err.message || err}\n`);
  process.exit(0); // fail-open
});
```

- [ ] **Step 5: Rodar e confirmar PASS**

```bash
node --test test/stop-hook.test.mjs
```

Expected: 8 tests passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/stop-review-hook.mjs test/stop-hook.test.mjs test/helpers/mock-fetch-preload.mjs
git -c commit.gpgsign=false commit -m "feat(hook): implement Stop review gate orchestrator

Reads hook stdin, validates env, builds prompt with redacted context
(last_assistant, git diff, changed files content), calls Qwen, parses
ALLOW/BLOCK first line, emits {decision:block,reason} on BLOCK.
Fail-open on any unexpected error. Persists lastReview to state.
QWEN_REVIEW_DEBUG=1 writes prompt/response to .qwen-review-debug.log."
```

---

## Task 7: `scripts/qwen-review.mjs` — CLI (setup/status/check)

CLI mínimo: `setup [--enable|--disable]` toggles the gate + faz ping na API; `status` mostra config + lastReview; `check [--diff-only]` roda review manual.

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/scripts/qwen-review.mjs`

(Não escrevemos teste dedicado pra este script — os comandos são wrappers do que já tem teste em outros tasks. O smoke test no Task 11 valida fim-a-fim.)

- [ ] **Step 1: Implementar `qwen-review.mjs`**

Path: `/var/home/mariostjr/Projetos/qwen-review/scripts/qwen-review.mjs`

```javascript
#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { loadState, getConfig, setConfig } from "./lib/config.mjs";
import { callQwen } from "./lib/qwen-client.mjs";
import { loadTemplate, interpolate, truncate } from "./lib/prompt.mjs";
import { redactSecrets, shouldSkipFile, isBinary } from "./lib/redactor.mjs";

// --- Git helpers (mirror of stop-review-hook.mjs; v0.2 should extract to lib/git.mjs) ---

function untrackedFiles(cwd) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function trackedChangedFiles(cwd) {
  try {
    return execFileSync("git", ["diff", "HEAD", "--name-only", "--diff-filter=ACMRT"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function trackedDiffForFile(cwd, file) {
  try {
    return execFileSync("git", ["diff", "HEAD", "--no-color", "--", file], {
      cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch { return ""; }
}

function syntheticDiffForUntracked(cwd, file) {
  try {
    return execFileSync("git", ["diff", "--no-index", "--no-color", "/dev/null", file], {
      cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (err) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

function gitDiff(cwd, extraGlobs = []) {
  const parts = [];
  for (const file of trackedChangedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\n[diff excluded: sensitive path]`);
      continue;
    }
    const d = trackedDiffForFile(cwd, file);
    if (d) parts.push(d);
  }
  for (const file of untrackedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\nnew file\n[diff excluded: sensitive path]`);
      continue;
    }
    const d = syntheticDiffForUntracked(cwd, file);
    if (d) parts.push(d);
  }
  return parts.filter(Boolean).join("\n");
}

function changedFiles(cwd) {
  return [...trackedChangedFiles(cwd), ...untrackedFiles(cwd)];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 6) return "•••";
  return `${key.slice(0, 3)}•••${key.slice(-3)}`;
}

function readEnv() {
  return {
    apiKey: process.env.QWEN_API_KEY || null,
    baseUrl:
      process.env.QWEN_BASE_URL ||
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL || "qwen3-max",
    mode: process.env.QWEN_REVIEW_MODE === "deep" ? "deep" : "fast"
  };
}

async function pingQwen(env) {
  const started = Date.now();
  try {
    await callQwen({
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      model: env.model,
      prompt: "ok",
      overrides: { maxTokens: 1, timeoutMs: 15_000 }
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err.message || String(err) };
  }
}

async function cmdSetup(args) {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const env = readEnv();
  const actions = [];

  let nextGate = getConfig(workspaceRoot).stopReviewGate;
  if (args.includes("--enable")) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    nextGate = true;
    actions.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (args.includes("--disable")) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    nextGate = false;
    actions.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const envOk = !!env.apiKey;
  const ping = envOk ? await pingQwen(env) : { ok: false, error: "QWEN_API_KEY not set" };

  const output = {
    ready: envOk && ping.ok,
    envOk,
    apiKey: maskKey(env.apiKey),
    baseUrl: env.baseUrl,
    model: env.model,
    mode: env.mode,
    reviewGateEnabled: nextGate,
    ping,
    actionsTaken: actions
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function cmdStatus() {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const env = readEnv();
  const state = loadState(workspaceRoot);
  const output = {
    workspaceRoot,
    envOk: !!env.apiKey,
    apiKey: maskKey(env.apiKey),
    baseUrl: env.baseUrl,
    model: env.model,
    mode: env.mode,
    reviewGateEnabled: state.config.stopReviewGate,
    lastReview: state.lastReview
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function buildCheckPrompt({ cwd, diffOnly, env }) {
  const diff = gitDiff(cwd);           // includes untracked synthetic diffs
  const files = changedFiles(cwd);     // tracked-modified ∪ untracked-new

  const blocks = [];
  for (const file of files.slice(0, 5)) {
    if (shouldSkipFile(file)) { blocks.push(`=== ${file} ===\n[file excluded: sensitive path]`); continue; }
    let buf;
    try { buf = fs.readFileSync(path.join(cwd, file)); } catch { continue; }
    if (isBinary(buf)) { blocks.push(`=== ${file} ===\n[file excluded: binary]`); continue; }
    let c = buf.toString("utf8");
    if (env.redactEnabled !== false) c = redactSecrets(c);
    if (c.length > 4000) c = c.slice(0, 4000) + "\n[truncated]";
    blocks.push(`=== ${file} ===\n${c}`);
  }

  const vars = {
    LAST_ASSISTANT: diffOnly ? "" : "(manual /qwen-review:check invocation)",
    GIT_DIFF: redactSecrets(truncate(diff, 12000)),
    CHANGED_FILES_CONTENT: blocks.join("\n\n")
  };
  return interpolate(loadTemplate(ROOT_DIR, "stop-review"), vars);
}

async function cmdCheck(args) {
  const env = readEnv();
  if (!env.apiKey) {
    process.stderr.write("qwen-review: QWEN_API_KEY not set\n");
    process.exit(2);
  }
  const cwd = resolveWorkspaceRoot(process.cwd());
  const diffOnly = args.includes("--diff-only");
  const prompt = buildCheckPrompt({ cwd, diffOnly, env: { redactEnabled: true } });
  const result = await callQwen({
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.model,
    prompt,
    mode: env.mode
  });
  process.stdout.write(result.content + "\n");
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case "setup":
      await cmdSetup(rest);
      break;
    case "status":
      cmdStatus();
      break;
    case "check":
      await cmdCheck(rest);
      break;
    default:
      process.stderr.write(`usage: qwen-review <setup|status|check> [args]\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`qwen-review: ${err.message || err}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Sanity check do CLI** (sem fazer chamada de rede)

```bash
node scripts/qwen-review.mjs status
```

Expected: JSON com `reviewGateEnabled: false`, `envOk` reflete se `QWEN_API_KEY` está setado, `lastReview: null`.

- [ ] **Step 3: Commit**

```bash
git add scripts/qwen-review.mjs
git -c commit.gpgsign=false commit -m "feat(cli): add qwen-review setup|status|check subcommands

setup [--enable|--disable] toggles gate + pings API.
status prints config + last review as JSON.
check [--diff-only] runs manual review of current git diff."
```

---

## Task 8: `commands/*.md` — wrappers de slash commands

Cada arquivo é um command stub que invoca o CLI Node. Sintaxe segue o padrão do codex (`.claude-plugin` plugin commands).

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/commands/setup.md`
- Create: `/var/home/mariostjr/Projetos/qwen-review/commands/status.md`
- Create: `/var/home/mariostjr/Projetos/qwen-review/commands/check.md`

- [ ] **Step 1: Criar `commands/setup.md`**

Path: `/var/home/mariostjr/Projetos/qwen-review/commands/setup.md`

```markdown
---
description: Toggle the Qwen 3.7 Max stop-time review gate for the current workspace and ping the API
argument-hint: '[--enable|--disable]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" setup $ARGUMENTS
```

Output rules:
- Present the JSON output to the user.
- If `envOk` is false, remind the user to set `QWEN_API_KEY` (and optionally `QWEN_BASE_URL`, `QWEN_MODEL`, `QWEN_REVIEW_MODE`).
- If `ping.ok` is false, surface the error message verbatim.
- If `actionsTaken` is non-empty, summarize what changed in one sentence.
```

- [ ] **Step 2: Criar `commands/status.md`**

Path: `/var/home/mariostjr/Projetos/qwen-review/commands/status.md`

```markdown
---
description: Show qwen-review configuration and the last review result for the current workspace
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" status
```

Present the JSON to the user. If `lastReview` is null, mention that no review has run yet.
```

- [ ] **Step 3: Criar `commands/check.md`**

Path: `/var/home/mariostjr/Projetos/qwen-review/commands/check.md`

```markdown
---
description: Run an on-demand Qwen review of the current git diff (does not affect the Stop gate)
argument-hint: '[--diff-only]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-review.mjs" check $ARGUMENTS
```

Output rules:
- Show the raw Qwen output to the user (it will start with `ALLOW:` or `BLOCK:` followed by a short reason).
- Do not interpret the result as a hard block — this command is informational only.
```

- [ ] **Step 4: Apagar `commands/.gitkeep`**

```bash
rm commands/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add commands/
git rm commands/.gitkeep
git -c commit.gpgsign=false commit -m "feat(commands): add /qwen-review:{setup,status,check} stubs

Each command is a thin wrapper that invokes the CLI under
scripts/qwen-review.mjs with the right subcommand and arguments."
```

---

## Task 9: `hooks/hooks.json` — registrar o Stop hook

Espelha o `hooks.json` do codex (estrutura) mas aponta pro nosso script com timeout 660s (cobre worst-case `deep` mode).

**Files:**
- Create: `/var/home/mariostjr/Projetos/qwen-review/hooks/hooks.json`

- [ ] **Step 1: Criar `hooks.json`**

Path: `/var/home/mariostjr/Projetos/qwen-review/hooks/hooks.json`

```json
{
  "description": "Stop-time review gate via Qwen 3.7 Max API",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-hook.mjs\"",
            "timeout": 660
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Apagar `hooks/.gitkeep`**

```bash
rm hooks/.gitkeep
```

- [ ] **Step 3: Validar JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json'))" && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add hooks/hooks.json
git rm hooks/.gitkeep
git -c commit.gpgsign=false commit -m "feat(hooks): register Stop hook with 660s timeout

660s covers worst-case 'deep' mode (600s API + margin)."
```

---

## Task 10: `README.md`

Documentação de instalação, env vars, troubleshooting e diferenças vs codex.

**Files:**
- Modify: `/var/home/mariostjr/Projetos/qwen-review/README.md` (sobrescreve o stub que tinha lá)

- [ ] **Step 1: Sobrescrever `README.md`**

Path: `/var/home/mariostjr/Projetos/qwen-review/README.md`

```markdown
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

### Mínimo viável

```bash
export QWEN_API_KEY=sk-...        # obrigatório
```

Depois, dentro de uma sessão Claude Code, no diretório do seu projeto:

```
/qwen-review:setup --enable
```

O gate fica habilitado apenas para esse workspace (state isolado por sha256 do realpath).

### Todas as variáveis de ambiente

| Var | Obrigatório | Default | Notas |
|---|---|---|---|
| `QWEN_API_KEY` | sim | — | Sem ela, o gate auto-skip com aviso |
| `QWEN_BASE_URL` | não | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | OpenAI-compat endpoint |
| `QWEN_MODEL` | não | `qwen3-max` | Override para outros nomes (ex: `qwen/qwen3-max` no OpenRouter) |
| `QWEN_REVIEW_MODE` | não | `fast` | `fast` (1024 tok, 120s, sem thinking) ou `deep` (8192 tok, 600s, thinking) |
| `QWEN_REVIEW_TIMEOUT_MS` | não | 120000 / 600000 | Override do timeout HTTP |
| `QWEN_REVIEW_MAX_TOKENS` | não | 1024 / 8192 | Override do cap de saída |
| `QWEN_REVIEW_MAX_FILES` | não | 5 | Quantos arquivos enviar em `CHANGED_FILES_CONTENT` |
| `QWEN_REVIEW_REDACT_SECRETS` | não | `1` | `0` desliga redaction (NÃO recomendado) |
| `QWEN_REVIEW_EXCLUDE_GLOBS` | não | — | Globs extras pra skip, separados por `:` |
| `QWEN_REVIEW_DEBUG` | não | `0` | `1` grava `.qwen-review-debug.log` no workspace |

## Comandos

| Comando | Descrição |
|---|---|
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
node --test test/    # roda todos os testes
node scripts/qwen-review.mjs status    # sanity check sem rede
```

Zero deps npm — tudo é Node nativo (`node:test`, `fetch`, `AbortController`).

## Licença

MIT.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git -c commit.gpgsign=false commit -m "docs(readme): install, env vars, commands, security, troubleshooting"
```

---

## Task 11: Smoke test manual + push final

Roda o conjunto de tests completo, valida critérios de aceite do spec §14 manualmente, e faz o push pro remote.

- [ ] **Step 1: Rodar todos os tests**

```bash
cd /var/home/mariostjr/Projetos/qwen-review
node --test test/
```

Expected: ~52 tests passed (workspace: 2, config: 6, redactor: 16, prompt: 8, qwen-client: 10, stop-hook: 10 — incluindo testes de untracked file e untracked-.env-skipped).

- [ ] **Step 2: Smoke install local** (simula instalação real)

```bash
ln -snf /var/home/mariostjr/Projetos/qwen-review ~/.claude/plugins/local/qwen-review
```

(Sai e reabra Claude Code. Confirme em `/plugin list` que `qwen-review` aparece.)

- [ ] **Step 3: Smoke test ALLOW** — gate on, edit limpo deve passar
  1. Garanta `QWEN_API_KEY` no env, rode `/qwen-review:setup --enable`
  2. Faça um edit trivial: adicione um comentário num arquivo já existente
  3. Termine o turn (stop)
  4. Expected: stop sem block; `/qwen-review:status` mostra `lastReview.decision: "allow"`

- [ ] **Step 4: Smoke test BLOCK** — edit obviamente errado deve bloquear
  1. Edit: substitua `return foo` por `return foo.undefiend.bar` num arquivo `.js`/`.ts`
  2. Termine o turn
  3. Expected: stderr/transcript mostra "Qwen review found issues: …", Claude continua o turn pra corrigir
  4. `/qwen-review:status` mostra `lastReview.decision: "block"` com a razão

- [ ] **Step 4b: Smoke test UNTRACKED NEW FILE** — arquivo novo (sem `git add`) também é revisado
  1. Em outro turn, peça pro Claude criar um arquivo `bug.js` novo (via Write tool) com `function f() { return null.foo; }`
  2. NÃO faça `git add`
  3. Termine o turn
  4. Expected: gate dispara, Qwen vê o arquivo via diff sintético, retorna BLOCK
  5. `/qwen-review:status` mostra `lastReview.decision: "block"` mencionando `bug.js`

- [ ] **Step 5: Smoke test REDACTION (content-level)** — cria arquivo com secret modificado deve ser redactado
  1. Edit: adicione `const apiKey = "sk-abc123def456ghi789jkl012mno345pqr"` num arquivo `.ts`
  2. `QWEN_REVIEW_DEBUG=1` na sessão
  3. Termine o turn
  4. Inspecione `.qwen-review-debug.log` no workspace
  5. Expected: a string `sk-abc123…` foi substituída por `[REDACTED:openai-or-qwen-key]` no prompt enviado

- [ ] **Step 5b: Smoke test FILE-SKIP** — `.env` ou `*.key` novo não vaza
  1. `QWEN_REVIEW_DEBUG=1` na sessão
  2. Crie via Write um arquivo `.env.local` com `INTERNAL_PASSWORD=hunter2`
  3. Termine o turn
  4. Inspecione `.qwen-review-debug.log`
  5. Expected: `hunter2` NÃO aparece; o bloco do arquivo aparece como `[diff excluded: sensitive path]` e `[file excluded: sensitive path]`

- [ ] **Step 6: Smoke test FAIL-OPEN** — chave inválida não bloqueia
  1. `QWEN_API_KEY=sk-invalid` na sessão (override)
  2. Faça qualquer edit
  3. Termine o turn
  4. Expected: stderr mostra "API rejected request (HTTP 401)", stop ocorre normalmente

- [ ] **Step 7: Smoke test GATE OFF** — desligar volta o comportamento ao padrão
  1. `/qwen-review:setup --disable`
  2. Faça edit, termine turn
  3. Expected: nenhuma chamada à API, nenhum aviso, stop limpo

- [ ] **Step 8: Push pro remote**

```bash
cd /var/home/mariostjr/Projetos/qwen-review
git log --oneline -20
git push origin main
```

Expected: ~11 commits novos no `main` do repo público.

- [ ] **Step 9: Tag v0.1.0**

```bash
git tag -a v0.1.0 -m "v0.1.0 — stop-time review gate via Qwen 3.7 Max"
git push origin v0.1.0
```

---

## Self-Review (executei após escrever)

**Spec coverage:**
- §3 Layout → Tasks 0, 8, 9 ✓
- §4 Fluxo do hook → Task 6 ✓
- §4.1 fail-open → Task 6 (tests cobrem 500, parse inválido, no API key) ✓
- §4.2 decision format → Task 6 ✓
- §5 Prompt template → Task 4 ✓
- §5.1 Truncamento → Task 4 (truncate fn) + Task 6 (usa LAST_ASSISTANT_HEAD/TAIL, DIFF_HEAD, PER_FILE_CAP, TOTAL_FILES_CAP) ✓
- §5.2 Redaction → Task 3 ✓
- §6 Cliente HTTP → Task 5 ✓
- §6.1 Modos fast/deep → Task 5 ✓
- §7 Comandos → Tasks 7, 8 ✓
- §8 Testes → cada task tem teste ✓
- §9 Observability → Task 2 (lastReview), Task 6 (stderr + debug log) ✓
- §10 Segurança → Task 3 + Task 2 (0o600) + Task 5 (mask key no /setup output) ✓
- §11 Env vars → Task 6 (consumption) + Task 7 (display) ✓
- §14 Critérios de aceite → Task 11 smoke tests cobrem todos ✓

**Placeholder scan:** nenhum TBD/TODO/"implementar depois"/"similar to Task N" detectado.

**Type/name consistency:** funções com mesmo nome batem entre tasks (`resolveWorkspaceRoot`, `loadState/saveState/setConfig/getConfig/saveLastReview/loadTemplate/interpolate/truncate/redactSecrets/shouldSkipFile/isBinary/callQwen/resolveModeParams/parseDecision`). Parâmetros consistentes (`cwd`, `apiKey`, `baseUrl`, `model`, `prompt`, `mode`, `overrides`).

**Conhecidos:**
- Test usando `Response` global precisa de Node ≥ 18 — pre-flight checa
- Mock fetch via `--import` preload depende de Node ≥ 20 (em 18.x o flag é `--experimental-loader`). Se ambiente for 18.x, ajustar para `node --experimental-loader` no comando `runHook`.
- Helpers de git (`gitTrackedDiff`, `untrackedFiles`, `syntheticDiffForUntracked`, `gitDiff`, `trackedChangedFiles`, `changedFiles`) estão duplicados entre `scripts/stop-review-hook.mjs` e `scripts/qwen-review.mjs`. v0.2 deve extrair pra `scripts/lib/git.mjs` (anotado como TODO no header da seção do Task 7).

## Execution Handoff

Plan completo e salvo em `docs/superpowers/plans/2026-05-23-qwen-review-gate.md`. Duas opções de execução:

**1. Subagent-Driven (recommended)** — Disparo um subagent fresco por task, revisão entre tasks, iteração rápida sem poluir o contexto principal.

**2. Inline Execution** — Executa as tasks nessa sessão usando `superpowers:executing-plans`, com checkpoints em batch.

Qual abordagem?
