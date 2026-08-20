import fs from "node:fs";

const raw = process.env.MOCK_RESPONSE;
const rawList = process.env.MOCK_RESPONSES;
const captureFile = process.env.CAPTURE_FILE;

if (raw || rawList) {
  // MOCK_RESPONSES: array JSON consumido na ordem das chamadas; esgotou,
  // repete a última. MOCK_RESPONSE (single) segue funcionando como antes.
  const specs = rawList ? JSON.parse(rawList) : [JSON.parse(raw)];
  let callIndex = 0;
  globalThis.fetch = async (url, opts) => {
    if (captureFile) {
      // CAPTURE_FILE guarda um ARRAY de {url, opts}, um por chamada.
      const prev = fs.existsSync(captureFile)
        ? JSON.parse(fs.readFileSync(captureFile, "utf8"))
        : [];
      prev.push({ url, opts });
      fs.writeFileSync(captureFile, JSON.stringify(prev, null, 2));
    }
    const spec = specs[Math.min(callIndex, specs.length - 1)];
    callIndex++;
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
