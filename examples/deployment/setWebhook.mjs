// Register (or delete) the Telegram webhook for your deployed worker. No dependencies — Node 18+ (global fetch).
//
// Usage:
//   TELEGRAM_BOT_TOKEN=123:abc node setWebhook.mjs https://your-bot.your-subdomain.workers.dev
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_WEBHOOK_SECRET=s3cret node setWebhook.mjs https://.../   # with origin secret
//   TELEGRAM_BOT_TOKEN=123:abc node setWebhook.mjs --info                                        # show current webhook
//   TELEGRAM_BOT_TOKEN=123:abc node setWebhook.mjs --delete                                      # remove the webhook
//
// If you set TELEGRAM_WEBHOOK_SECRET here, set the SAME value as the worker's TELEGRAM_WEBHOOK_SECRET secret
// (see .dev.vars.example) — the worker rejects any update whose secret-token header doesn't match.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in the environment.");
  process.exit(1);
}
const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
const arg = process.argv[2];

async function call(method, body) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  console.log(method, "→", JSON.stringify(data, null, 2));
  if (!data?.ok) process.exit(1);
}

if (arg === "--info") {
  await call("getWebhookInfo");
} else if (arg === "--delete") {
  await call("deleteWebhook", { drop_pending_updates: false });
} else {
  const url = arg || process.env.WORKER_URL;
  if (!url || !/^https:\/\//.test(url)) {
    console.error("Pass the worker URL: node setWebhook.mjs https://your-bot.workers.dev");
    process.exit(1);
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  await call("setWebhook", {
    url,
    // Only the update types the engine handles — keeps noise down.
    allowed_updates: ["message", "edited_message"],
    ...(secret ? { secret_token: secret } : {}),
  });
  await call("getWebhookInfo");
}
