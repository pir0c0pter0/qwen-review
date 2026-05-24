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
