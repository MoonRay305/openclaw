import path from "node:path";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { readMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

type BeforeDispatchResult = { handled: true; text: string } | undefined;

type BeforeDispatchEvent = {
  transcript?: string;
  body?: string;
  content?: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
};

type VoiceFieldRouterConfig = {
  enabled?: boolean;
  channel?: string;
  accountId?: string;
  timeoutMs?: number;
  senderId?: string;
  botUsername?: string;
  voiceFieldUserId?: string;
};

const DEFAULT_ENDPOINT = "https://voice-field.2rook.ai/webhook";
const EXPECTED_BOT_USERNAME = "@DoubleRookVoiceFieldBot";
const VOICE_FIELD_ORIGIN = "https://voice-field.2rook.ai";
const VOICE_FIELD_SSRF_POLICY = {
  allowedHostnames: ["voice-field.2rook.ai"],
  allowedOrigins: [VOICE_FIELD_ORIGIN],
};
const DEFAULT_FAILURE_REPLY =
  "Voice Field is temporarily unavailable. Your memo was not filed; please retry.";
const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_PHOTO_BYTES = 50 * 1024 * 1024;
const MISSING_ACCOUNT_REPLY =
  "Voice Field routing is unavailable because the Telegram account identity is missing. Your memo was not filed.";
const MISSING_SENDER_REPLY =
  "Voice Field routing is unavailable because the Telegram sender identity is missing. Your memo was not filed.";

function normalizeConfig(
  value: unknown,
): Required<Pick<VoiceFieldRouterConfig, "enabled" | "channel" | "timeoutMs">> &
  VoiceFieldRouterConfig {
  const config = value && typeof value === "object" ? (value as VoiceFieldRouterConfig) : {};
  return {
    ...config,
    enabled: config.enabled === true,
    channel: config.channel?.trim() || "telegram",
    accountId: config.accountId?.trim(),
    senderId: config.senderId?.trim(),
    botUsername: config.botUsername?.trim(),
    voiceFieldUserId: config.voiceFieldUserId?.trim(),
    timeoutMs:
      Number.isFinite(config.timeoutMs) && Number(config.timeoutMs) > 0
        ? Number(config.timeoutMs)
        : 15_000,
  };
}

function pickText(event: BeforeDispatchEvent): string {
  return (
    [event.transcript, event.body, event.content]
      .find((value) => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? ""
  );
}

async function buildWebhookBody(params: {
  text: string;
  userId: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
}): Promise<{ body: BodyInit; contentType?: string }> {
  const photos = (params.mediaPaths ?? []).flatMap((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      return [];
    }
    const claimedMime =
      typeof params.mediaTypes?.[index] === "string"
        ? params.mediaTypes[index]?.trim().toLowerCase()
        : undefined;
    if (claimedMime && !claimedMime.startsWith("image/")) {
      return [];
    }
    return [{ candidate: value.trim(), claimedMime }];
  });
  if (photos.length === 0) {
    return {
      body: JSON.stringify({ userId: params.userId, text: params.text }),
      contentType: "application/json",
    };
  }
  if (photos.length > MAX_PHOTOS) {
    throw new Error("Voice Field photo limit exceeded");
  }

  const form = new FormData();
  form.append("userId", params.userId);
  form.append("text", params.text);
  let totalBytes = 0;
  for (const { candidate, claimedMime } of photos) {
    const id = path.basename(candidate).trim();
    if (!id || id === "." || id === "..") {
      throw new Error("Voice Field media attachment rejected");
    }
    const media = await readMediaBuffer(id, "inbound", MAX_PHOTO_BYTES);
    if (path.resolve(media.path) !== path.resolve(candidate)) {
      throw new Error("Voice Field media attachment rejected");
    }
    totalBytes += media.size;
    if (totalBytes > MAX_TOTAL_PHOTO_BYTES) {
      throw new Error("Voice Field total photo limit exceeded");
    }
    const mime = await detectMime({
      buffer: media.buffer,
      headerMime: claimedMime,
      filePath: id,
    });
    if (!mime?.startsWith("image/")) {
      throw new Error("Voice Field media attachment is not an image");
    }
    form.append("photos", new Blob([new Uint8Array(media.buffer)], { type: mime }), id);
  }
  return { body: form };
}

async function routeWithGuardedFetch(params: {
  text: string;
  userId: string;
  timeoutMs: number;
  mediaPaths?: string[];
  mediaTypes?: string[];
}): Promise<string> {
  const headers: Record<string, string> = {};
  const token = process.env.VOICE_FIELD_WEBHOOK_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const request = await buildWebhookBody(params);
  if (request.contentType) {
    headers["content-type"] = request.contentType;
  }
  const guarded = await fetchWithSsrFGuard({
    url: DEFAULT_ENDPOINT,
    init: {
      method: "POST",
      headers,
      body: request.body,
      signal: AbortSignal.timeout(params.timeoutMs),
    },
    policy: VOICE_FIELD_SSRF_POLICY,
    requireHttps: true,
    pinDns: true,
    maxRedirects: 0,
    auditContext: "voice-field-router.webhook",
  });
  try {
    if (!guarded.response.ok) {
      throw new Error(`Voice Field returned HTTP ${guarded.response.status}`);
    }
    const payload = (await guarded.response.json()) as { success?: unknown; message?: unknown };
    if (payload.success !== true) {
      throw new Error("Voice Field reported success=false");
    }
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      throw new Error("Voice Field returned no message");
    }
    return payload.message.trim();
  } finally {
    await guarded.release();
  }
}

export default definePluginEntry({
  id: "voice-field-router",
  name: "Voice Field Router",
  description: "Deterministically routes dedicated Telegram bot messages to Voice Field",
  register(api) {
    api.on(
      "before_dispatch",
      async (event, ctx): Promise<BeforeDispatchResult> => {
        const config = normalizeConfig(api.pluginConfig);
        if (!config.enabled) {
          return undefined;
        }
        const senderId = event.senderId || ctx.senderId;
        if (event.channel !== config.channel) {
          return undefined;
        }
        if (config.botUsername !== EXPECTED_BOT_USERNAME) {
          api.logger.error?.(
            "voice-field-router: botUsername is not @DoubleRookVoiceFieldBot; refusing dispatch",
          );
          return undefined;
        }
        if (!config.accountId?.trim()) {
          api.logger.error?.("voice-field-router: configured accountId missing; refusing dispatch");
          return undefined;
        }
        if (!config.senderId?.trim()) {
          api.logger.error?.("voice-field-router: configured senderId missing; refusing dispatch");
          return undefined;
        }
        if (!ctx.accountId) {
          api.logger.error?.("voice-field-router: Telegram accountId missing; refusing dispatch");
          return { handled: true, text: MISSING_ACCOUNT_REPLY };
        }
        if (ctx.accountId !== config.accountId) {
          return undefined;
        }
        if (!senderId) {
          api.logger.error?.("voice-field-router: Telegram senderId missing; refusing dispatch");
          return { handled: true, text: MISSING_SENDER_REPLY };
        }
        if (senderId !== config.senderId) {
          return undefined;
        }
        const text = pickText(event);
        if (!text || !config.voiceFieldUserId) {
          return { handled: true, text: DEFAULT_FAILURE_REPLY };
        }
        try {
          const reply = await routeWithGuardedFetch({
            text,
            userId: config.voiceFieldUserId,
            timeoutMs: config.timeoutMs,
            mediaPaths: event.mediaPaths,
            mediaTypes: event.mediaTypes,
          });
          return { handled: true, text: reply };
        } catch (error) {
          api.logger.warn?.(`voice-field-router: delivery failed (${String(error)})`);
          return { handled: true, text: DEFAULT_FAILURE_REPLY };
        }
      },
      { priority: 100, timeoutMs: 20_000 },
    );
  },
});
