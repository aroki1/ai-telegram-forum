import assert from "node:assert/strict";
import test from "node:test";

// config.ts validates on import, so these land before anything is loaded.
process.env.BOT_TOKEN ??= "test-token";
process.env.FORUM_CHAT_ID ??= "-100123";
process.env.ALLOWED_USER_ID ??= "1";
process.env.DEFAULT_CWD ??= process.cwd();
process.env.PERMISSION ??= "bypass";
process.env.OPENCODE_GO_API_KEY = "oc_sk_test-key";
process.env.OPENCODE_GO_BASE_URL = "https://opencode.test/v1";

test("OpenCode Go model ids accept the opencode-go/ spelling and reject slashes", async () => {
  const { normalizeGoModel } = await import("../src/go-model.ts");
  assert.equal(normalizeGoModel("kimi-k3"), "kimi-k3");
  assert.equal(normalizeGoModel("opencode-go/kimi-k3"), "kimi-k3");
  assert.equal(normalizeGoModel("deepseek/deepseek-v4-flash"), null);
  assert.equal(normalizeGoModel("not a model"), null);
  assert.equal(normalizeGoModel(""), null);
});

test("only the responses families are refused; Qwen and MiniMax ride chat/completions", async () => {
  const { goFormatOf } = await import("../src/go-model.ts");
  // Verified against the live gateway: these all answer `chat/completions`
  // with 200 even though the docs table lists Qwen and MiniMax under
  // `@ai-sdk/anthropic` — that column describes OpenCode's own client, not
  // what the endpoint accepts.
  for (const id of [
    "qwen3.8-max",
    "qwen3.7-plus",
    "minimax-m3",
    "glm-5.2",
    "kimi-k3",
    "deepseek-v4-flash",
    "mimo-v2.6-flash",
    "hy3",
    "longcat-2.0",
  ]) {
    assert.equal(goFormatOf(id), "oa-compat", id);
  }
  for (const id of ["grok-4.7", "grok-4.6", "gpt-5.6-luna", "muse-spark-1.3-contributor"]) {
    assert.equal(goFormatOf(id), "responses", id);
  }
});

test("the Go transport sends a stable x-opencode-session and its own user agent", async () => {
  const { OpenCodeGoClient } = await import("../src/opencode-go.ts");
  let sessionId = "session-one";
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new OpenCodeGoClient(() => sessionId, async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(
      JSON.stringify({
        model: "kimi-k3",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  await client.complete({ model: "kimi-k3", messages: [] });
  // The id only exists after the first turn, so it is read live per request.
  sessionId = "session-two";
  await client.complete({ model: "kimi-k3", messages: [] });

  assert.equal(seen[0]?.url, "https://opencode.test/v1/chat/completions");
  assert.equal(seen[0]?.headers["x-opencode-session"], "session-one");
  assert.equal(seen[1]?.headers["x-opencode-session"], "session-two");
  assert.match(seen[0]?.headers["User-Agent"] ?? "", /^ai-telegram-forum\//);
  assert.equal(seen[0]?.headers.Authorization, "Bearer oc_sk_test-key");
});

test("Go grades errors by error.type, so a format refusal never reads as a bad key", async () => {
  const { OpenCodeGoClient } = await import("../src/opencode-go.ts");
  // The gateway answers 401 for `ModelError` as well as `AuthError`; only the
  // type tells them apart.
  const client = new OpenCodeGoClient(() => "session", async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "ModelError", message: "Model grok-4.7 is not supported for format oa-compat" },
      }),
      { status: 401 },
    ),
  );
  await assert.rejects(
    () => client.complete({ model: "grok-4.7", messages: [] }),
    (err: Error) => /model error/.test(err.message) && !/authorization failed/.test(err.message),
  );

  const badKey = new OpenCodeGoClient(() => "session", async () =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "AuthError", message: "Unauthorized" } }),
      { status: 401 },
    ),
  );
  await assert.rejects(
    () => badKey.complete({ model: "kimi-k3", messages: [] }),
    /authorization failed.*OPENCODE_GO_API_KEY was rejected/,
  );
});

test("a responses-family model never reaches the wire and the topic is told why", async () => {
  const { OpenCodeGoAgentSession } = await import("../src/opencode-go-session.ts");
  let requests = 0;
  const { OpenCodeGoClient } = await import("../src/opencode-go.ts");
  // Any transport call at all would mean the refusal happened too late.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("should not run", { status: 200 });
  }) as typeof fetch;
  void OpenCodeGoClient;

  let resolveEnded!: (result: any) => void;
  const ended = new Promise<any>((resolve) => (resolveEnded = resolve));
  try {
    const session = new OpenCodeGoAgentSession({
      bot: {} as any,
      threadId: 7,
      cwd: process.cwd(),
      sessionId: null,
      effort: null,
      model: "grok-4.7",
      serviceTier: null,
      chat: { model: "grok-4.7" },
      channel: {
        server: {} as any,
        send: async () => ({ content: [{ type: "text", text: "sent" }] }),
        sent: 0,
        resetSent: () => {},
      } as any,
      hooks: {
        beginTurn: async () => {},
        session: () => {},
        text: () => {},
        tool: () => {},
        endTurn: async (result: any) => resolveEnded(result),
      },
    });

    await session.send({ text: "hello", images: [] });
    const result = await ended;
    assert.equal(result.ok, false);
    assert.match(String(result.failure), /responses/);
    assert.match(String(result.failure), /Grok/);
    assert.equal(requests, 0);
    session.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
