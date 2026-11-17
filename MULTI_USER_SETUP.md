# AI Stock Watcher — Multi-user rollout

## Architecture
- Cloudflare Worker: market-data proxy, LINE webhook, LIFF authentication, watchlist API, scheduled alert scanner.
- Cloudflare D1: users, personal watchlists, per-user signal states, alert audit log and screener ideas.
- LINE Messaging API: commands and push alerts.
- LINE LIFF (under a LINE Login channel): website identity. Both website and LINE resolve to the same LINE user ID and D1 watchlist.
- Market data: Alpaca IEX. This is periodic polling, not a guaranteed real-time consolidated feed.

## Defaults
- Maximum 50 symbols per user.
- Default watchlist for a new LINE friend: ASTS, RKLB, IONQ, OKLO.
- Screener universe starts with the existing 20-symbol universe and is designed to expand.
- Scheduled alert scan: every 15 minutes. Actual delivery depends on Cloudflare limits, Alpaca availability and LINE push limits.
- Alerts are sent only after a user's stored status changes. The first scan initializes state without sending a signal alert.

## 1. Create D1
Cloudflare Dashboard → Workers & Pages → D1 SQL Database → Create database:
- Name: `ai-stock-watcher-db`
- Open Console and run the complete SQL in `schema.sql`.

Then open Worker → Settings → Bindings → Add → D1 database:
- Variable name: `DB`
- Select `ai-stock-watcher-db`

## 2. Worker variables and secrets
Keep existing secrets:
- `ALPACA_KEY`
- `ALPACA_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Add Worker secrets:
- `APP_SESSION_SECRET`: random string at least 32 characters (use a password manager / password generator).
- `LINE_LOGIN_CHANNEL_ID`: Channel ID of a LINE Login channel (not the Messaging API channel ID).

Add variable:
- `LIFF_ID`: LIFF ID created under that LINE Login channel (public value).

Do not paste any secret into GitHub, this chat, or frontend files.

## 3. Create LINE Login + LIFF
In LINE Developers, under the same Provider as the Messaging API channel:
1. Create a LINE Login channel.
2. Configure its Callback URL as the GitHub Pages website URL if required by the LINE console.
3. Add a LIFF app to that LINE Login channel.
4. LIFF endpoint URL: `https://bombbomb725-debug.github.io/Ai-stock-watcher/`
5. Enable `openid` and `profile` scopes; add the website URL as an allowed endpoint.
6. Copy the LIFF ID into Worker variable `LIFF_ID` and into `window.AI_STOCK_WATCHER_CONFIG.LIFF_ID` in `index.html`.
7. Deploy Worker and website. Open the website from the LIFF app or tap Login.

The existing Messaging API channel is not itself a LINE Login channel. Do not reuse its channel ID as LINE_LOGIN_CHANNEL_ID.

## 4. Worker binding and scheduled trigger
- Bind D1 as `DB`.
- Add Cron Trigger `*/15 * * * *` in Worker → Settings → Triggers → Cron Triggers.
- Deploy the latest `worker.js` and `wrangler.toml`.
- Confirm Worker root returns service status and D1 is available.

## 5. LINE OA settings
- Keep Messaging API Webhook URL: `https://ai-stock-watcher-api.bombbomb725.workers.dev/line/webhook`
- Keep Use webhook ON.
- Disable LINE OA auto-responses/greeting responses if they duplicate Worker replies.
- Users must add the OA as a friend to receive push alerts.

## LINE commands
- `เพิ่ม NVDA` or `/add NVDA`
- `ลบ NVDA` or `/remove NVDA`
- `รายการหุ้น` or `/list`
- `หุ้นแนะนำ` or `/ideas`
- `ช่วยเหลือ` or `/help`

## API
- `POST /api/auth/line` { idToken } → app session
- `GET /api/me` (Bearer app session)
- `GET /api/watchlist` (Bearer app session)
- `POST /api/watchlist/add` { symbol }
- `POST /api/watchlist/remove` { symbol }
- `GET /api/ideas`
- Existing `GET /api/market?symbols=...` and `GET /api/assets?q=...`

## Security and operating notes
- The Worker verifies LINE ID tokens server-side. Never trust a userId sent by the browser.
- The app session is an HMAC-signed token; keep APP_SESSION_SECRET private and rotate it if exposed.
- D1 queries are parameterized. Each API operation is scoped to the authenticated user.
- 50 is the per-user watchlist limit; market requests accept up to 50 symbols.
- The screener currently uses transparent technical scoring (EMA20/50, RSI14, MACD, breakout and volume), not an LLM making guaranteed predictions.
- The scanner is a scheduled polling system. It is not tick-by-tick real time.
- Verify Cloudflare account quotas and Alpaca plan/data permissions before increasing scan frequency or universe size.
