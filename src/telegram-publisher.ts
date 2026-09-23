import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Api, TelegramClient, sessions } from "teleproto";
import { cfg } from "./config.ts";

const { StringSession } = sessions;

const SESSION_FILE = () => resolve(cfg.telegramUserSessionPath);

function requireApiCredentials(): { apiId: number; apiHash: string } {
  if (!cfg.telegramUserApiId || !cfg.telegramUserApiHash) {
    throw new Error(
      "Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH with `npm run setup-telegram-publisher`.",
    );
  }
  return { apiId: cfg.telegramUserApiId, apiHash: cfg.telegramUserApiHash };
}

function clientFor(session: string): TelegramClient<InstanceType<typeof StringSession>> {
  const { apiId, apiHash } = requireApiCredentials();
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
    requestRetries: 2,
  });
}

export type LoginPrompt = (label: string, secret?: boolean) => Promise<string>;

async function choosePublishChannel(
  client: TelegramClient<InstanceType<typeof StringSession>>,
  prompt: LoginPrompt,
): Promise<Api.Channel> {
  const dialogs = await client.getDialogs({});
  const channels = dialogs
    .map((dialog) => dialog.entity)
    .filter(
      (entity): entity is Api.Channel =>
        entity instanceof Api.Channel &&
        (entity.creator || entity.adminRights?.postMessages === true),
    );

  if (channels.length === 0) {
    throw new Error("No channels found where this account has permission to post.");
  }

  const configured = channels.find(
    (channel) => channel.id.toString() === cfg.telegramPublishChannelId,
  );
  if (configured) return configured;

  console.log("\nChannels available for posting:");
  channels.forEach((channel, index) => {
    console.log(`  ${index + 1}. ${channel.title} (id ${channel.id.toString()})`);
  });

  const answer = await prompt("Choose the channel number:");
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= channels.length) {
    throw new Error("Invalid channel selection.");
  }
  const selected = channels[index]!;
  const envPath = resolve(".env");
  const env = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const updated = env
    .split(/\r?\n/)
    .filter((line) => !/^TELEGRAM_PUBLISH_CHANNEL_ID=/.test(line))
    .join("\n")
    .replace(/\n*$/, "\n") +
    `TELEGRAM_PUBLISH_CHANNEL_ID=${selected.id.toString()}\n`;
  await writeFile(envPath, updated, "utf8");
  console.log(`[telegram-publisher] selected channel saved to ${envPath}`);
  return selected;
}

/** Log in once and persist the user authorization outside version control. */
export async function loginTelegramPublisher(prompt: LoginPrompt): Promise<void> {
  requireApiCredentials();
  const path = SESSION_FILE();
  const previous = existsSync(path) ? await readFile(path, "utf8") : "";
  const client = clientFor(previous.trim());

  try {
    await client.start({
      phoneNumber: () => prompt("Telegram phone number (with country code):"),
      phoneCode: () => prompt("Login code from Telegram:", true),
      password: () => prompt("Telegram 2FA password:", true),
      onError: (error) => {
        console.error(`[telegram-publisher] login error: ${error.message}`);
      },
    });
    await choosePublishChannel(client, prompt);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, client.session.save(), { encoding: "utf8", mode: 0o600 });
    console.log(`[telegram-publisher] session saved locally at ${path}`);
  } finally {
    await client.disconnect();
  }
}

/** Publish to the one channel configured by the local operator, as that user. */
export async function publishToTelegramChannel(text: string): Promise<number> {
  if (!cfg.telegramPublisherEnabled) {
    throw new Error(
      "Channel publishing is not configured. Run `npm run setup-telegram-publisher` first.",
    );
  }
  const body = text.trim();
  if (!body) throw new Error("post text is empty");
  if (body.length > 4096) throw new Error("post exceeds Telegram's 4096-character limit");

  const path = SESSION_FILE();
  if (!existsSync(path)) {
    throw new Error("Telegram account is not signed in. Run `npm run telegram-publisher-login`.");
  }

  const client = clientFor((await readFile(path, "utf8")).trim());
  try {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      throw new Error("Telegram account session expired. Run `npm run telegram-publisher-login`.");
    }

    const dialogs = await client.getDialogs({});
    const channel = dialogs
      .map((dialog) => dialog.entity)
      .find(
        (entity): entity is Api.Channel =>
          entity instanceof Api.Channel &&
          entity.id.toString() === cfg.telegramPublishChannelId &&
          (entity.creator || entity.adminRights?.postMessages === true),
      );
    if (!channel) {
      throw new Error("Configured private channel is unavailable or this account cannot post there.");
    }
    const message = await client.sendMessage(channel, {
      message: body,
      sendAs: "me",
      linkPreview: false,
    });
    return message.id;
  } finally {
    await client.disconnect();
  }
}
