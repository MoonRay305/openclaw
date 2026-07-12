import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
//#region index.ts
const DEFAULT_ENDPOINT = "https://voice-field.2rook.ai/webhook";
const EXPECTED_BOT_USERNAME = "@DoubleRookVoiceFieldBot";
const VOICE_FIELD_SSRF_POLICY = {
	allowedHostnames: ["voice-field.2rook.ai"],
	allowedOrigins: ["https://voice-field.2rook.ai"]
};
const DEFAULT_FAILURE_REPLY = "Voice Field is temporarily unavailable. Your memo was not filed; please retry.";
const MISSING_ACCOUNT_REPLY = "Voice Field routing is unavailable because the Telegram account identity is missing. Your memo was not filed.";
const MISSING_SENDER_REPLY = "Voice Field routing is unavailable because the Telegram sender identity is missing. Your memo was not filed.";
function normalizeConfig(value) {
	const config = value && typeof value === "object" ? value : {};
	return {
		...config,
		enabled: config.enabled === true,
		channel: config.channel?.trim() || "telegram",
		accountId: config.accountId?.trim(),
		senderId: config.senderId?.trim(),
		botUsername: config.botUsername?.trim(),
		voiceFieldUserId: config.voiceFieldUserId?.trim(),
		timeoutMs: Number.isFinite(config.timeoutMs) && Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15e3
	};
}
function pickText(event) {
	return [
		event.transcript,
		event.body,
		event.content
	].find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}
async function routeWithGuardedFetch(params) {
	const headers = { "content-type": "application/json" };
	const token = process.env.VOICE_FIELD_WEBHOOK_TOKEN?.trim();
	if (token) headers.authorization = `Bearer ${token}`;
	const guarded = await fetchWithSsrFGuard({
		url: DEFAULT_ENDPOINT,
		init: {
			method: "POST",
			headers,
			body: JSON.stringify({
				userId: params.userId,
				text: params.text
			}),
			signal: AbortSignal.timeout(params.timeoutMs)
		},
		policy: VOICE_FIELD_SSRF_POLICY,
		requireHttps: true,
		pinDns: true,
		maxRedirects: 0,
		auditContext: "voice-field-router.webhook"
	});
	try {
		if (!guarded.response.ok) throw new Error(`Voice Field returned HTTP ${guarded.response.status}`);
		const payload = await guarded.response.json();
		if (payload.success !== true) throw new Error("Voice Field reported success=false");
		if (typeof payload.message !== "string" || !payload.message.trim()) throw new Error("Voice Field returned no message");
		return payload.message.trim();
	} finally {
		await guarded.release();
	}
}
var voice_field_router_default = definePluginEntry({
	id: "voice-field-router",
	name: "Voice Field Router",
	description: "Deterministically routes dedicated Telegram bot messages to Voice Field",
	register(api) {
		api.on("before_dispatch", async (event, ctx) => {
			const config = normalizeConfig(api.pluginConfig);
			if (!config.enabled) return;
			const senderId = event.senderId || ctx.senderId;
			if (event.channel !== config.channel) return;
			if (config.botUsername !== EXPECTED_BOT_USERNAME) {
				api.logger.error?.("voice-field-router: botUsername is not @DoubleRookVoiceFieldBot; refusing dispatch");
				return;
			}
			if (!config.accountId?.trim()) {
				api.logger.error?.("voice-field-router: configured accountId missing; refusing dispatch");
				return;
			}
			if (!config.senderId?.trim()) {
				api.logger.error?.("voice-field-router: configured senderId missing; refusing dispatch");
				return;
			}
			if (!ctx.accountId) {
				api.logger.error?.("voice-field-router: Telegram accountId missing; refusing dispatch");
				return {
					handled: true,
					text: MISSING_ACCOUNT_REPLY
				};
			}
			if (ctx.accountId !== config.accountId) return;
			if (!senderId) {
				api.logger.error?.("voice-field-router: Telegram senderId missing; refusing dispatch");
				return {
					handled: true,
					text: MISSING_SENDER_REPLY
				};
			}
			if (senderId !== config.senderId) return;
			const text = pickText(event);
			if (!text || !config.voiceFieldUserId) return {
				handled: true,
				text: DEFAULT_FAILURE_REPLY
			};
			try {
				return {
					handled: true,
					text: await routeWithGuardedFetch({
						text,
						userId: config.voiceFieldUserId,
						timeoutMs: config.timeoutMs
					})
				};
			} catch (error) {
				api.logger.warn?.(`voice-field-router: delivery failed (${String(error)})`);
				return {
					handled: true,
					text: DEFAULT_FAILURE_REPLY
				};
			}
		}, {
			priority: 100,
			timeoutMs: 2e4
		});
	}
});
//#endregion
export { voice_field_router_default as default };
