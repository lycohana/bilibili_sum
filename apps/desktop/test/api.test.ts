import assert from "node:assert/strict";

function run(name: string, fn: () => Promise<void> | void) {
  Promise.resolve(fn()).then(() => {
    console.log(`ok - ${name}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

run("calls markdown export api with obsidian target", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const requests: Array<{ url: string; options?: RequestInit }> = [];

  globalThis.window = { location: { origin: "http://127.0.0.1:3838" } } as typeof window;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      task_id: "task-1",
      target_format: "obsidian",
      path: "C:/vault/note.md",
      directory: "C:/vault",
      file_name: "note.md",
      overwritten: false,
      artifact_key: "obsidian_note_path",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const { api } = await import("../src/api.ts");
  const response = await api.exportTaskMarkdown("task-1", { target: "obsidian" });

  assert.equal(response.target_format, "obsidian");
  assert.equal(requests[0]?.url, "/api/v1/tasks/task-1/exports/markdown");
  assert.equal(requests[0]?.options?.method, "POST");
  assert.match(String(requests[0]?.options?.body), /"target":"obsidian"/);

  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});
