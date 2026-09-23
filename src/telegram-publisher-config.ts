import "dotenv/config";

const apiIdRaw = process.env.TELEGRAM_USER_API_ID?.trim() ?? "";
const telegramUserApiId = apiIdRaw ? Number(apiIdRaw) : null;
if (apiIdRaw && (!Number.isSafeInteger(telegramUserApiId) || telegramUserApiId! <= 0)) {
  throw new Error("TELEGRAM_USER_API_ID must be a positive integer");
}

const telegramUserApiHash = process.env.TELEGRAM_USER_API_HASH?.trim() ?? "";
const telegramPublishChannelId = process.env.TELEGRAM_PUBLISH_CHANNEL_ID?.trim() ?? "";
if (telegramPublishChannelId && !/^\d+$/.test(telegramPublishChannelId)) {
  throw new Error("TELEGRAM_PUBLISH_CHANNEL_ID must be a numeric channel id");
}

export const telegramPublisherCfg = {
  telegramUserApiId,
  telegramUserApiHash,
  telegramPublishChannelId,
  telegramPublisherEnabled: Boolean(
    telegramUserApiId && telegramUserApiHash && telegramPublishChannelId,
  ),
  telegramUserSessionPath:
    process.env.TELEGRAM_USER_SESSION_PATH ?? "./data/telegram-user-session.txt",
} as const;
