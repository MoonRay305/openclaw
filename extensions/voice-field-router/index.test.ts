import { beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

const { guardedFetchMock, releaseMock, readMediaBufferMock, detectMimeMock } = vi.hoisted(() => ({
  guardedFetchMock: vi.fn(),
  releaseMock: vi.fn(),
  readMediaBufferMock: vi.fn(),
  detectMimeMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: guardedFetchMock,
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  readMediaBuffer: readMediaBufferMock,
}));

vi.mock("openclaw/plugin-sdk/media-mime", () => ({
  detectMime: detectMimeMock,
}));

const DEFAULT_FAILURE_REPLY_FOR_TEST =
  "Voice Field is temporarily unavailable. Your memo was not filed; please retry.";

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
    readMediaBufferMock.mockReset();
    detectMimeMock.mockReset();
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

  it("keeps transcribed Telegram voice notes on the text-only JSON path", async () => {
    guardedFetchMock.mockResolvedValue({
      response: new Response(JSON.stringify({ success: true, message: "Transcript accepted." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });

    const result = await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "",
        transcript: "[PROJECT: Dr. Grattan] Crew of two today.",
        senderId: "6003416166",
        mediaPaths: ["/root/.openclaw/media/inbound/voice-note.ogg"],
        mediaTypes: ["audio/ogg"],
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({ handled: true, text: "Transcript accepted." });
    expect(readMediaBufferMock).not.toHaveBeenCalled();
    const body = guardedFetchMock.mock.calls[0]?.[0]?.init?.body;
    expect(JSON.parse(String(body))).toEqual({
      userId: "landon",
      text: "[PROJECT: Dr. Grattan] Crew of two today.",
    });
  });

  it("forwards Telegram photos as guarded multipart webhook fields", async () => {
    readMediaBufferMock.mockResolvedValue({
      id: "photo-a.jpg",
      path: "/root/.openclaw/media/inbound/photo-a.jpg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      size: 4,
    });
    detectMimeMock.mockResolvedValue("image/jpeg");
    guardedFetchMock.mockResolvedValue({
      response: new Response(JSON.stringify({ success: true, message: "Photo accepted." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });

    const result = await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "[PROJECT: Dr. Grattan] Roof photo.",
        senderId: "6003416166",
        mediaPaths: ["/root/.openclaw/media/inbound/photo-a.jpg"],
        mediaTypes: ["image/jpeg"],
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({ handled: true, text: "Photo accepted." });
    expect(readMediaBufferMock).toHaveBeenCalledWith("photo-a.jpg", "inbound", 10 * 1024 * 1024);
    const call = guardedFetchMock.mock.calls[0]?.[0];
    expect(call?.init?.headers).toEqual(
      expect.not.objectContaining({ "content-type": expect.anything() }),
    );
    expect(call?.init?.body).toBeInstanceOf(FormData);
    const form = call?.init?.body as FormData;
    expect(form.get("userId")).toBe("landon");
    expect(form.get("text")).toBe("[PROJECT: Dr. Grattan] Roof photo.");
    const photo = form.get("photos");
    expect(photo).toBeInstanceOf(Blob);
    expect((photo as Blob).type).toBe("image/jpeg");
    expect((photo as Blob).size).toBe(4);
  });

  it("rejects a staged-path mismatch before any webhook request", async () => {
    readMediaBufferMock.mockResolvedValue({
      id: "photo-a.jpg",
      path: "/root/.openclaw/media/inbound/different.jpg",
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      size: 4,
    });

    const result = await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "[PROJECT: Dr. Grattan] Roof photo.",
        senderId: "6003416166",
        mediaPaths: ["/root/.openclaw/media/inbound/photo-a.jpg"],
        mediaTypes: ["image/jpeg"],
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({ handled: true, text: DEFAULT_FAILURE_REPLY_FOR_TEST });
    expect(detectMimeMock).not.toHaveBeenCalled();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-image bytes even when Telegram claims an image MIME", async () => {
    readMediaBufferMock.mockResolvedValue({
      id: "photo-a.jpg",
      path: "/root/.openclaw/media/inbound/photo-a.jpg",
      buffer: Buffer.from("not-an-image"),
      size: 12,
    });
    detectMimeMock.mockResolvedValue("application/pdf");

    const result = await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "[PROJECT: Dr. Grattan] Roof photo.",
        senderId: "6003416166",
        mediaPaths: ["/root/.openclaw/media/inbound/photo-a.jpg"],
        mediaTypes: ["image/jpeg"],
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({ handled: true, text: DEFAULT_FAILURE_REPLY_FOR_TEST });
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before file reads when Telegram supplies too many photos", async () => {
    const mediaPaths = Array.from(
      { length: 11 },
      (_, index) => `/root/.openclaw/media/inbound/photo-${index}.jpg`,
    );
    const result = await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "[PROJECT: Dr. Grattan] Roof photos.",
        senderId: "6003416166",
        mediaPaths,
        mediaTypes: mediaPaths.map(() => "image/jpeg"),
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    expect(result).toEqual({ handled: true, text: DEFAULT_FAILURE_REPLY_FOR_TEST });
    expect(readMediaBufferMock).not.toHaveBeenCalled();
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it("forwards multiple Telegram photos in source order", async () => {
    readMediaBufferMock.mockImplementation(async (id: string) => ({
      id,
      path: `/root/.openclaw/media/inbound/${id}`,
      buffer: Buffer.from(
        id === "photo-a.jpg" ? [0xff, 0xd8, 0xff, 0xd9] : [0x89, 0x50, 0x4e, 0x47],
      ),
      size: 4,
    }));
    detectMimeMock.mockResolvedValueOnce("image/jpeg").mockResolvedValueOnce("image/png");
    guardedFetchMock.mockResolvedValue({
      response: new Response(JSON.stringify({ success: true, message: "Photos accepted." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });

    await hooks.before_dispatch(
      {
        channel: "telegram",
        content: "[PROJECT: Dr. Grattan] Roof photos.",
        senderId: "6003416166",
        mediaPaths: [
          "/root/.openclaw/media/inbound/photo-a.jpg",
          "/root/.openclaw/media/inbound/photo-b.png",
        ],
        mediaTypes: ["image/jpeg", "image/png"],
        isGroup: false,
      },
      { channelId: "telegram", accountId: "default", senderId: "6003416166" },
    );

    const form = guardedFetchMock.mock.calls[0]?.[0]?.init?.body as FormData;
    const photos = form.getAll("photos") as Blob[];
    expect(photos).toHaveLength(2);
    expect(photos.map((photo) => photo.type)).toEqual(["image/jpeg", "image/png"]);
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
