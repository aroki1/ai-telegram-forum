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

test("the responses families resolve to the responses dialect, not a refusal", async () => {
  const { goDialectFor } = await import("../src/opencode-go.ts");
  assert.equal(goDialectFor("kimi-k3")?.format, "oa-compat");
  assert.equal(goDialectFor("qwen3.8-max")?.format, "oa-compat");
  // Verified live: these refuse `chat/completions` and answer `responses`.
  assert.equal(goDialectFor("grok-4.7")?.format, "responses");
  assert.equal(goDialectFor("gpt-5.6-luna")?.format, "responses");
  assert.equal(goDialectFor("muse-spark-1.3-contributor")?.format, "responses");
});

test("the responses dialect orders reasoning before the call it produced", async () => {
  const { responsesDialect } = await import("../src/dialect-responses.ts");
  const dialect = responsesDialect({ label: "OpenCode Go", defaultContextWindow: 64_000 });

  const body = dialect.buildRequest(
    {
      model: "grok-4.7",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: "on it",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "Read", arguments: '{"file_path":"a.txt"}' },
            },
          ],
          // With `store: false` this comes back encrypted and must be replayed.
          wire: { items: [{ type: "reasoning", encrypted_content: "blob" }] },
        },
        { role: "tool", tool_call_id: "call-1", content: "hello from a.txt" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "Read", description: "Read a file.", parameters: { type: "object" } },
        },
      ],
      maxTokens: 100,
    },
    null,
  );

  assert.equal(body.instructions, "You are terse.");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 100);
  assert.equal("max_tokens" in body, false);
  assert.equal("models" in body, false);

  const input = body.input as any[];
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ["user", "reasoning", "message", "function_call", "function_call_output"],
  );
  assert.equal(input.at(-1).call_id, "call-1");
  assert.equal(input.at(-1).output, "hello from a.txt");

  // Tools are flat here, unlike chat/completions where they nest under `function`.
  const tools = body.tools as any[];
  assert.equal(tools[0].name, "Read");
  assert.equal("function" in tools[0], false);
});

test("the responses dialect reads reasoning and calls back into one normalized message", async () => {
  const { responsesDialect } = await import("../src/dialect-responses.ts");
  const dialect = responsesDialect({ label: "OpenCode Go", defaultContextWindow: 64_000 });
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "blob", summary: [] };

  const read = dialect.readResponse({
    model: "grok-4.7",
    status: "completed",
    output: [
      reasoning,
      { type: "function_call", call_id: "call-9", name: "Read", arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
  });

  assert.equal(read.message?.role, "assistant");
  assert.equal(read.message?.content, null);
  assert.equal(read.message?.tool_calls?.[0]?.id, "call-9");
  assert.equal(read.message?.tool_calls?.[0]?.function.name, "Read");
  assert.deepEqual((read.message?.wire as any).items, [reasoning]);
  assert.equal(read.resolvedModel, "grok-4.7");
  assert.equal(read.usage.inTokens, 10);
  // Go reports tokens and never dollars on this route either.
  assert.equal(read.usage.costUsd, null);

  // A 200 body can carry the failure, so it has to surface as one.
  assert.throws(
    () => dialect.readResponse({ error: { message: "Upstream request failed" } }),
    /Upstream request failed/,
  );
});

test("effort clamps to the levels the responses API knows", async () => {
  const { responsesDialect } = await import("../src/dialect-responses.ts");
  const dialect = responsesDialect({ label: "OpenCode Go", defaultContextWindow: 64_000 });
  const forEffort = (effort: any) =>
    dialect.buildRequest({ model: "grok-4.7", messages: [], tools: [], effort }, null).reasoning;
  assert.deepEqual(forEffort("low"), { effort: "low" });
  assert.deepEqual(forEffort("xhigh"), { effort: "high" });
  assert.equal(forEffort(null), undefined);
});

test("a model no provider can resolve fails before any request is made", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ChatAgentSession } = await import("../src/chat-session.ts");
  const { openCodeGoDialect } = await import("../src/opencode-go.ts");

  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("should not run", { status: 200 });
  }) as typeof fetch;

  const root = await mkdtemp(join(tmpdir(), "go-unsupported-"));
  let resolveEnded!: (result: any) => void;
  const ended = new Promise<any>((resolve) => (resolveEnded = resolve));
  try {
    const session = new ChatAgentSession(
      {
        bot: {} as any,
        threadId: 9,
        cwd: process.cwd(),
        sessionId: null,
        effort: null,
        model: "some-future-model",
        serviceTier: null,
        chat: { model: "some-future-model" },
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
      },
      {
        dialect: openCodeGoDialect,
        dialectFor: () => null,
        unsupported: (model) => `❌ ${model} needs a wire format this build lacks`,
        client: () => ({
          complete: async () => {
            requests++;
            return {};
          },
        }),
        defaultModel: "kimi-k3",
        historyRoot: root,
        maxSteps: 4,
        turnTimeoutMs: 5_000,
        maxToolOutput: 1_000,
      },
    );

    await session.send({ text: "hello", images: [] });
    const result = await ended;
    assert.equal(result.ok, false);
    assert.match(String(result.failure), /needs a wire format this build lacks/);
    assert.equal(requests, 0);
    session.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
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
