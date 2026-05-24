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
    assert.equal(body.extra_body, undefined);
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
