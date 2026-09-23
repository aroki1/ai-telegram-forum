import { createInterface } from "node:readline";
import { loginTelegramPublisher } from "./telegram-publisher.ts";

async function ask(label: string, secret = false): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  output.write(`${label} `);

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const readline = createInterface({ input, output });
    try {
      return await new Promise<string>((resolveAnswer) =>
        readline.question("", resolveAnswer),
      );
    } finally {
      readline.close();
    }
  }

  return await new Promise<string>((resolveAnswer, rejectAnswer) => {
    let answer = "";
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) rejectAnswer(error);
      else resolveAnswer(answer);
    };

    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\u0003") return finish(new Error("login cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") {
          answer = Array.from(answer).slice(0, -1).join("");
          if (!secret) output.write("\b \b");
        } else if (char >= " ") {
          answer += char;
          if (!secret) output.write(char);
        }
      }
    };

    input.on("data", onData);
  });
}

loginTelegramPublisher(ask).catch((error) => {
  console.error(`[telegram-publisher] ${String(error)}`);
  process.exitCode = 1;
});
