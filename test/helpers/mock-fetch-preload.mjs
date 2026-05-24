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
