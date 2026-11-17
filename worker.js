const ALLOWED_SYMBOLS = new Set(["ASTS", "RKLB", "IONQ", "OKLO"]);
const ALLOWED_ORIGINS = new Set([
  "https://bombbomb725-debug.github.io",
]);

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  // Requests from Safari's address bar or server-side clients may have no Origin.
  // They can receive JSON, but browser CORS access is granted only to our dashboard.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: "Origin not allowed" }, 403, headers);
      }
      return new Response(null, { status: 204, headers });
    }

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origin not allowed" }, 403, headers);
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, headers);
    }

    if (url.pathname === "/") {
      return json({
        service: "AI Stock Watcher API",
        status: "ready",
        endpoint: "/api/market?symbols=ASTS,RKLB,IONQ,OKLO",
      }, 200, headers);
    }

    if (url.pathname !== "/api/market") {
      return json({ error: "Not found" }, 404, headers);
    }

    if (!env.ALPACA_KEY || !env.ALPACA_SECRET) {
      return json({
        error: "Worker secrets are missing",
        required: ["ALPACA_KEY", "ALPACA_SECRET"],
      }, 503, headers);
    }

    const requested = (url.searchParams.get("symbols") || "ASTS,RKLB,IONQ,OKLO")
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => ALLOWED_SYMBOLS.has(symbol));

    const symbols = [...new Set(requested)];

    if (symbols.length === 0) {
      return json({ error: "No supported symbols requested" }, 400, headers);
    }

    const authHeaders = {
      "APCA-API-KEY-ID": env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": env.ALPACA_SECRET,
    };

    const alpacaBase = "https://data.alpaca.markets/v2";

    try {
      const barsUrl = new URL(alpacaBase + "/stocks/bars");
      barsUrl.searchParams.set("symbols", symbols.join(","));
      barsUrl.searchParams.set("timeframe", "1Day");
      barsUrl.searchParams.set("limit", "100");
      barsUrl.searchParams.set("feed", "iex");
      barsUrl.searchParams.set("adjustment", "raw");

      const [barsResponse, ...tradeResponses] = await Promise.all([
        fetch(barsUrl, { headers: authHeaders }),
        ...symbols.map((symbol) =>
          fetch(
            alpacaBase + "/stocks/" + encodeURIComponent(symbol) + "/trades/latest?feed=iex",
            { headers: authHeaders }
          )
        ),
      ]);

      if (!barsResponse.ok) {
        const detail = await barsResponse.text();
        return json({
          error: "Alpaca bars request failed",
          status: barsResponse.status,
          detail: detail.slice(0, 500),
        }, 502, headers);
      }

      const barsData = await barsResponse.json();
      const stocks = {};

      for (let i = 0; i < symbols.length; i++) {
        let trade = null;
        const tradeResponse = tradeResponses[i];

        if (tradeResponse.ok) {
          const tradeData = await tradeResponse.json();
          trade = tradeData.trade || null;
        }

        stocks[symbols[i]] = {
          bars: barsData.bars?.[symbols[i]] || [],
          trade,
        };
      }

      return json({
        feed: "Alpaca IEX",
        fetchedAt: new Date().toISOString(),
        stocks,
      }, 200, headers);
    } catch (error) {
      return json({
        error: "Market data request failed",
        detail: String(error).slice(0, 300),
      }, 502, headers);
    }
  },
};
