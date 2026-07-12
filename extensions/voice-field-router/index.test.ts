import { beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

const { guardedFetchMock, releaseMock } = vi.hoisted(() => ({
  guardedFetchMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: guardedFetchMock,
}));

describe("voice-field-router plugin", () => {
  const hooks: Record<string, Function> = {};
  const api = {
    pluginConfig: {
      enabled: true,
      channel: "telegram",
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
      timeoutMs: 5000,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    on: vi.fn((name: string, handler: Function) => {
      hooks[name] = handler;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(api.pluginConfig, {
      enabled: true,
      channel: "telegram",
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
      timeoutMs: 5000,
    });
    guardedFetchMock.mockReset();
    releaseMock.mockReset();
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    vi.stubGlobal("fetch", vi.fn());
    register.register(api as never);
  });

  it("does not register the unreachable inbound_claim hook", () => {
    expect(hooks.inbound_claim).toBeUndefined();
  });

  it("defaults to disabled when plugin config is empty", async () => {
    for (const key of Object.keys(api.pluginConfig)) {
      delete (api.pluginConfig as Record<string, unknown>)[key];
    }
    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("does not claim messages when the router is disabled", async () => {
    api.pluginConfig.enabled = false;
    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("does not claim non-Telegram messages", async () => {
    const result = await hooks.before_dispatch(
      { channel: "discord", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "discord", accountId: "default", senderId: "6003416166" },
    );
    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("routes literal YES with the exact Voice Field identity", async () => {
    guardedFetchMock.mockResolvedValue({
      response: new Response(JSON.stringify({ success: true, message: "Daily log filed." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });
    await hooks.before_dispatch(
      { channel: "telegram", content: "YES", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    const call = guardedFetchMock.mock.calls[0]?.[0];
    expect(JSON.parse(String(call?.init?.body))).toEqual({ userId: "landon", text: "YES" });
  });

  it("routes a voice transcript when the channel body is empty", async () => {
    guardedFetchMock.mockResolvedValue({
      response: new Response(JSON.stringify({ success: true, message: "Transcript accepted." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });
    await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "",
        transcript: "[PROJECT: Dr. Grattan] Crew of two today.",
        senderId: "6003416166",
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    const call = guardedFetchMock.mock.calls[0]?.[0];
    expect(JSON.parse(String(call?.init?.body)).text).toBe(
      "[PROJECT: Dr. Grattan] Crew of two today.",
    );
  });

  it("fails closed on a non-2xx guarded response and releases the dispatcher", async () => {
    guardedFetchMock.mockResolvedValue({
      response: new Response(JSON.stringify({ success: false }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });
    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    expect(result).toEqual({
      handled: true,
      text: "Voice Field is temporarily unavailable. Your memo was not filed; please retry.",
    });
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("fails closed when guarded fetch rejects", async () => {
    guardedFetchMock.mockRejectedValue(new Error("blocked"));
    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    expect(result).toEqual({
      handled: true,
      text: "Voice Field is temporarily unavailable. Your memo was not filed; please retry.",
    });
  });

  it("fails closed when Telegram senderId is absent on the dedicated account", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: undefined },
    );

    expect(result).toEqual({
      handled: true,
      text: "Voice Field routing is unavailable because the Telegram sender identity is missing. Your memo was not filed.",
    });
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when configured senderId is absent", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: undefined,
      voiceFieldUserId: "landon",
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when configured accountId is absent", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: undefined,
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Telegram accountId is absent", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: undefined, senderId: "6003416166" },
    );

    expect(result).toEqual({
      handled: true,
      text: "Voice Field routing is unavailable because the Telegram account identity is missing. Your memo was not filed.",
    });
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("does not claim an account that is not attested as DoubleRookVoiceFieldBot", async () => {
    (api.pluginConfig as Record<string, unknown>).botUsername = "@DifferentBot";
    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );
    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("does not claim a different sender on the dedicated account", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "other-sender", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "other-sender" },
    );

    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("does not claim a different Telegram account", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "other", senderId: "6003416166" },
    );

    expect(result).toBeUndefined();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("treats HTTP 200 with success false as a delivery failure", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });
    guardedFetchMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ success: false, message: "The request was not accepted." }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: releaseMock,
    });

    const result = await hooks.before_dispatch(
      { channel: "telegram", content: "memo", senderId: "6003416166", isGroup: false },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({
      handled: true,
      text: "Voice Field is temporarily unavailable. Your memo was not filed; please retry.",
    });
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("routes an exactly scoped before_dispatch message through the pinned guarded fetch", async () => {
    const config = api.pluginConfig as Record<string, unknown>;
    Object.assign(config, {
      accountId: "default",
      senderId: "6003416166",
      botUsername: "@DoubleRookVoiceFieldBot",
      voiceFieldUserId: "landon",
    });
    guardedFetchMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ success: true, message: "Preview ready. Reply YES to file." }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: releaseMock,
    });

    const result = await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "[PROJECT: Dr. Grattan] Framing is 50 percent.",
        senderId: "6003416166",
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({
      handled: true,
      text: "Preview ready. Reply YES to file.",
    });
    expect(guardedFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://voice-field.2rook.ai/webhook",
        requireHttps: true,
        pinDns: true,
        maxRedirects: 0,
        policy: {
          allowedHostnames: ["voice-field.2rook.ai"],
          allowedOrigins: ["https://voice-field.2rook.ai"],
        },
      }),
    );
    expect(releaseMock).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
