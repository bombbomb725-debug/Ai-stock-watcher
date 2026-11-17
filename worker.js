const DEFAULT_SYMBOLS = ["ASTS", "RKLB", "IONQ", "OKLO"];
const ALLOWED_ORIGINS = new Set(["https://bombbomb725-debug.github.io"]);

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}
function validSymbol(s) { return /^[A-Z][A-Z0-9.]{0,9}$/.test(s); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed", origin }, 403, headers);
      return new Response(null, { status: 204, headers });
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed", origin }, 403, headers);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, headers);

    if (url.pathname === "/") {
      return json({
        service: "AI Stock Watcher API",
        status: "ready",
        limits: { symbolsPerRequest: 20 },
        endpoints: ["/api/market?symbols=ASTS,RKLB", "/api/assets?q=NVDA"]
      }, 200, headers);
    }
    if (!env.ALPACA_KEY || !env.ALPACA_SECRET) {
      return json({ error: "Worker secrets are missing", required: ["ALPACA_KEY", "ALPACA_SECRET"] }, 503, headers);
    }

    const authHeaders = {
      "APCA-API-KEY-ID": env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_SECRET
    };

    if (url.pathname === "/api/assets") {
      const q = (url.searchParams.get("q") || "").trim().toUpperCase();
      if (!q || q.length > 30) return json({ assets: [] }, 200, headers);
      try {
        const r = await fetch("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity", { headers: authHeaders });
        if (!r.ok) return json({ error: "Alpaca asset search failed", status: r.status, detail: (await r.text()).slice(0, 300) }, 502, headers);
        const all = await r.json();
        const matches = all.filter(a => {
          if (!a.tradable || !a.exchange) return false;
          const symbol = (a.symbol || "").toUpperCase();
          const name = (a.name || "").toUpperCase();
          return symbol.includes(q) || name.includes(q);
        }).slice(0, 20).map(a => ({ symbol: a.symbol, name: a.name, exchange: a.exchange }));
        return json({ assets: matches }, 200, headers);
      } catch (e) {
        return json({ error: "Asset search failed", detail: String(e).slice(0, 250) }, 502, headers);
      }
    }

    if (url.pathname !== "/api/market") return json({ error: "Not found" }, 404, headers);
    const requested = (url.searchParams.get("symbols") || DEFAULT_SYMBOLS.join(","))
      .split(",").map(s => s.trim().toUpperCase()).filter(validSymbol);
    const symbols = [...new Set(requested)];
    if (!symbols.length) return json({ error: "No supported symbols requested" }, 400, headers);
    if (symbols.length > 20) return json({ error: "Maximum 20 symbols per request", max: 20 }, 400, headers);

    try {
      const base = "https://data.alpaca.markets/v2";
      const end = new Date();
      const start = new Date(end.getTime() - 140 * 24 * 60 * 60 * 1000);
      const barsUrl = new URL(base + "/stocks/bars");
      barsUrl.searchParams.set("symbols", symbols.join(","));
      barsUrl.searchParams.set("timeframe", "1Day");
      barsUrl.searchParams.set("start", start.toISOString());
      barsUrl.searchParams.set("end", end.toISOString());
      barsUrl.searchParams.set("limit", "1000");
      barsUrl.searchParams.set("feed", "iex");
      barsUrl.searchParams.set("sort", "asc");
      barsUrl.searchParams.set("adjustment", "raw");

      const [barsResponse, ...tradeResponses] = await Promise.all([
        fetch(barsUrl, { headers: authHeaders }),
        ...symbols.map(s => fetch(base + "/stocks/" + encodeURIComponent(s) + "/trades/latest?feed=iex", { headers: authHeaders }))
      ]);
      if (!barsResponse.ok) {
        const detail = await barsResponse.text();
        return json({ error: "Alpaca bars request failed", status: barsResponse.status, detail: detail.slice(0, 400) }, 502, headers);
      }
      const barsData = await barsResponse.json();
      const returnedBars = barsData.bars || {};
      const stocks = {};
      for (let i = 0; i < symbols.length; i++) {
        let trade = null;
        if (tradeResponses[i].ok) {
          const td = await tradeResponses[i].json();
          trade = td.trade || null;
        }
        stocks[symbols[i]] = { bars: returnedBars[symbols[i]] || [], trade };
      }
      const barCounts = Object.fromEntries(symbols.map(s => [s, stocks[s].bars.length]));
      return json({
        feed: "Alpaca IEX",
        fetchedAt: new Date().toISOString(),
        diagnostics: {
          barsHttpStatus: barsResponse.status,
          requestedStart: start.toISOString(),
          requestedEnd: end.toISOString(),
          requestedSymbols: symbols,
          returnedSymbols: Object.keys(returnedBars),
          barCounts,
          hasNextPageToken: Boolean(barsData.next_page_token)
        },
        stocks
      }, 200, headers);
    } catch (e) {
      return json({ error: "Market data request failed", detail: String(e).slice(0, 300) }, 502, headers);
    }
  }
};
