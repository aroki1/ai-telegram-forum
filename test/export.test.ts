import assert from "node:assert/strict";
import test from "node:test";

// config.ts validates on import, so these land before anything is loaded.
process.env.BOT_TOKEN ??= "test-token";
process.env.FORUM_CHAT_ID ??= "-100123";
process.env.ALLOWED_USER_ID ??= "1";
process.env.DEFAULT_CWD ??= process.cwd();
process.env.PERMISSION ??= "bypass";

test("transcriptMarkdown exports conversation content without the system prompt", async () => {
  const { transcriptMarkdown } = await import("../src/export.ts");
  const markdown = transcriptMarkdown(
    [
      { role: "system", content: "internal prompt" },
      { role: "user", content: "Inspect this" },
      {
        role: "assistant",
        content: "I will read the file.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "Read", arguments: '{"snippet":"```"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "```\nfile contents\n```" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Done." },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ],
    {
      title: "Example topic",
      provider: "OpenCode Go",
      model: "kimi-k3",
      sessionId: "session-123",
      exportedAt: new Date("2026-09-23T00:00:00.000Z"),
    },
  );

  assert.match(markdown, /^# Example topic/m);
  assert.match(markdown, /- agent: OpenCode Go/);
  assert.match(markdown, /- model: kimi-k3/);
  assert.match(markdown, /- session: `session-123`/);
  assert.match(markdown, /- turns: 2/);
  assert.match(markdown, /- exported: 2026-09-23T00:00:00\.000Z/);
  assert.match(markdown, /## 👤 User\nInspect this/);
  assert.match(markdown, /\*\*Read\*\*/);
  assert.match(markdown, /````\n\{"snippet":"```"\}\n````/);
  assert.match(markdown, /## 🔧 Tool result/);
  assert.match(markdown, /Done\.\n_\[image\]_/);
  assert.doesNotMatch(markdown, /internal prompt/);
});
