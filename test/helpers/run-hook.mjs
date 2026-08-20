import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..", "..");
const HOOK = path.join(ROOT_DIR, "scripts", "stop-review-hook.mjs");

export function runHook({ cwd, input = {}, env = {}, mockResponse, mockResponses }) {
  const preload = path.join(ROOT_DIR, "test", "helpers", "mock-fetch-preload.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", preload, HOOK],
    {
      cwd,
      input: JSON.stringify(input),
      env: {
        ...process.env,
        ...env,
        MOCK_RESPONSE: mockResponse ? JSON.stringify(mockResponse) : "",
        MOCK_RESPONSES: mockResponses ? JSON.stringify(mockResponses) : ""
      },
      encoding: "utf8"
    }
  );
  return result;
}

export const ALLOW_RESPONSE = {
  status: 200,
  body: { choices: [{ message: { content: "ALLOW: ok" } }] }
};
