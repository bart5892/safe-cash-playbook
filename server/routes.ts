import type { Express } from "express";
import type { Server } from "http";

// ── HTTP helper ────────────────────────────────────────────────────────────────
async function fetchJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ...headers,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ── CoinGecko — BTC & ETH (free, no key) ─────────────────────────────────────
// Returns: { bitcoin: { usd, usd_24h_change, usd_24h_vol }, ethereum: {...} }
async function fetchCryptoprices() {
  const data = await fetchJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true"
  );
  const btcPrice = data.bitcoin?.usd ?? 0;
  const ethPrice = data.ethereum?.usd ?? 0;
  const btcPct = data.bitcoin?.usd_24h_change ?? 0;
  const ethPct = data.ethereum?.usd_24h_change ?? 0;
  return { btcPrice, ethPrice, btcPct, ethPct };
}

// ── Yahoo Finance v8 — VIX, S&P 500, ^IRX (3M T-Bill) ───────────────────────
// Returns regularMarketPrice and chartPreviousClose for any symbol
async function fetchYahooQuote(symbol: string): Promise<{ price: number; prev: number; pct: number }> {
  const encoded = encodeURIComponent(symbol);
  const data = await fetchJSON(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`
  );
  const meta = data?.chart?.result?.[0]?.meta ?? {};
  const price: number = meta.regularMarketPrice ?? 0;
  const prev: number = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const pct: number = prev ? ((price - prev) / prev) * 100 : 0;
  return { price, prev, pct };
}

// ── Treasury.gov CSV — full yield curve (free, no key) ────────────────────────
// Returns latest row: { date, "1 Mo", "3 Mo", "6 Mo", "1 Yr", "2 Yr", "5 Yr", "10 Yr", "30 Yr" }
async function fetchTreasuryYieldCurve(): Promise<{ date: string; yields: Record<string, number> }> {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/${yyyymm}?type=daily_treasury_yield_curve&field_tdr_date_value=${yyyymm}`;
  const csv = await fetchText(url);

  const lines = csv.trim().split("\n").filter(Boolean);
  if (lines.length < 2) throw new Error("Empty yield curve CSV");

  // Header: Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
  const headers = lines[0].split(",").map((h: string) => h.replace(/"/g, "").trim());
  // Most recent row is first (rows are newest-first)
  const latestRow = lines[1].split(",").map((v: string) => v.replace(/"/g, "").trim());

  const yields: Record<string, number> = {};
  headers.forEach((h: string, i: number) => {
    if (h !== "Date" && latestRow[i]) {
      yields[h] = parseFloat(latestRow[i]) || 0;
    }
  });

  return { date: latestRow[0], yields };
}

// ── NY Fed SOFR API (free, no key) ────────────────────────────────────────────
// https://markets.newyorkfed.org/api/rates/secured/sofr/last/3.json
async function fetchSOFR(): Promise<{ rate: number; date: string }> {
  const data = await fetchJSON("https://markets.newyorkfed.org/api/rates/secured/sofr/last/3.json");
  const rates = data?.refRates ?? [];
  // Most recent entry first
  const latest = rates[0];
  return { rate: latest?.percentRate ?? 3.65, date: latest?.effectiveDate ?? "" };
}

// ── FOMC calendar 2026 — rules-based regime detection ────────────────────────
const FOMC_DATES_2026: [number, number][] = [
  [3, 17], [3, 18],   // Mar 17–18
  [4, 28], [4, 29],   // Apr 28–29
  [6, 16], [6, 17],   // Jun 16–17
  [7, 28], [7, 29],   // Jul 28–29
  [9, 15], [9, 16],   // Sep 15–16
  [10, 27], [10, 28], // Oct 27–28
  [12, 8],  [12, 9],  // Dec 8–9
];

function detectRegime(vix: number, btcBasis: number, sofr: number, isFomcWeek: boolean) {
  if (isFomcWeek) {
    return {
      activeRegime: "Macro Event Week",
      tradeSignal: "NO SHORT VOL",
      riskLevel: "Critical",
      regimeColor: "error",
      regimeNote: `FOMC decision window. Avoid new short-vol. Watch for Event Fade post-announcement.`,
    };
  }
  if (vix > 30) {
    return {
      activeRegime: "High Vol Regime",
      tradeSignal: "Back-End Vol Selling",
      riskLevel: "Medium",
      regimeColor: "warning",
      regimeNote: `VIX ${vix.toFixed(1)} — elevated. Sell 8–12w / buy wings.`,
    };
  }
  if (vix < 16) {
    return {
      activeRegime: "Low Vol / Compressed Surface",
      tradeSignal: "Gamma Scalping",
      riskLevel: "Low",
      regimeColor: "primary",
      regimeNote: `VIX ${vix.toFixed(1)} — compressed. Gamma scalping setup.`,
    };
  }
  return {
    activeRegime: "Steady Contango Vol Curve",
    tradeSignal: "BTC/ETH Basis Carry",
    riskLevel: "Very Low",
    regimeColor: "success",
    regimeNote: `BTC basis ~${btcBasis.toFixed(1)}% (+${(btcBasis - sofr).toFixed(1)}% vs SOFR). Core carry active.`,
  };
}

// ── Crypto.com futures basis ─────────────────────────────────────────────────
async function fetchFuturesBasis(): Promise<{
  btcBasis: number | null;
  ethBasis: number | null;
  basisExpiry: string;
  daysToExpiry: number;
  btcFutPrice: number | null;
  ethFutPrice: number | null;
}> {
  const BASE = "https://api.crypto.com/exchange/v1/public";

  async function getQuote(instrument: string) {
    const data = await fetchJSON(`${BASE}/get-tickers?instrument_name=${instrument}`);
    const t = data?.result?.data?.[0] ?? {};
    const bid  = parseFloat(t.b  ?? 0);
    const ask  = parseFloat(t.k  ?? 0);
    const last = parseFloat(t.a  ?? 0);
    const mid  = (bid > 0 && ask > 0) ? (bid + ask) / 2 : last;
    return { mid, last };
  }

  const [btcSpotQ, btcFutQ, ethSpotQ, ethFutQ] = await Promise.all([
    getQuote("BTC_USD"),
    getQuote("BTCUSD-260626"),
    getQuote("ETH_USD"),
    getQuote("ETHUSD-260626"),
  ]);

  const today      = new Date();
  const expiry     = new Date("2026-06-26");
  const daysToExpiry = Math.max(1, Math.round((expiry.getTime() - today.getTime()) / 86400000));

  function annualisedBasis(spot: number, futures: number): number | null {
    if (!spot || !futures) return null;
    return +( ((futures - spot) / spot) * (365 / daysToExpiry) * 100 ).toFixed(2);
  }

  const btcSpot = btcSpotQ.mid || btcSpotQ.last;
  const btcFut  = btcFutQ.mid  || btcFutQ.last;
  const ethSpot = ethSpotQ.mid || ethSpotQ.last;
  const ethFut  = ethFutQ.mid  || ethFutQ.last;

  return {
    btcBasis:     annualisedBasis(btcSpot, btcFut),
    ethBasis:     annualisedBasis(ethSpot, ethFut),
    basisExpiry:  "Jun 26, 2026",
    daysToExpiry,
    btcFutPrice:  btcFut  || null,
    ethFutPrice:  ethFut  || null,
  };
}

// ── Route registration ────────────────────────────────────────────────────────
export function registerRoutes(httpServer: Server, app: Express) {

  // Health check for Render/Railway
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/dashboard", async (req, res) => {
    try {
      // Fetch all data sources in parallel
      const [crypto, vixData, sp500Data, dxyData, treasury, sofrData, basisData] = await Promise.allSettled([
        fetchCryptoprices(),
        fetchYahooQuote("^VIX"),
        fetchYahooQuote("^GSPC"),
        fetchYahooQuote("DX-Y.NYB"),
        fetchTreasuryYieldCurve(),
        fetchSOFR(),
        fetchFuturesBasis(),
      ]);

      // ── Crypto ────────────────────────────────────────────────────────────
      const btcPrice = crypto.status === "fulfilled" ? crypto.value.btcPrice : 72000;
      const ethPrice = crypto.status === "fulfilled" ? crypto.value.ethPrice : 2200;
      const btcPct   = crypto.status === "fulfilled" ? crypto.value.btcPct : 0;
      const ethPct   = crypto.status === "fulfilled" ? crypto.value.ethPct : 0;

      // ── VIX & S&P 500 ─────────────────────────────────────────────────────
      const vix     = vixData.status === "fulfilled" ? vixData.value.price : 20;
      const vixPct  = vixData.status === "fulfilled" ? vixData.value.pct : 0;
      const sp500   = sp500Data.status === "fulfilled" ? sp500Data.value.price : 6700;
      const sp500Pct = sp500Data.status === "fulfilled" ? sp500Data.value.pct : 0;

      // ── DXY (US Dollar Index) ─────────────────────────────────────────────
      const dxy    = dxyData.status === "fulfilled" ? dxyData.value.price : 104;
      const dxyPct = dxyData.status === "fulfilled" ? dxyData.value.pct   : 0;

      // ── Yield curve ───────────────────────────────────────────────────────
      const ycRaw = treasury.status === "fulfilled" ? treasury.value.yields : {};
      const ycDate = treasury.status === "fulfilled" ? treasury.value.date : "N/A";

      const yc = {
        "1M":  ycRaw["1 Mo"]  || 3.74,
        "3M":  ycRaw["3 Mo"]  || 3.72,
        "6M":  ycRaw["6 Mo"]  || 3.71,
        "1Y":  ycRaw["1 Yr"]  || 3.63,
        "2Y":  ycRaw["2 Yr"]  || 3.68,
        "5Y":  ycRaw["5 Yr"]  || 3.79,
        "10Y": ycRaw["10 Yr"] || 4.20,
        "30Y": ycRaw["30 Yr"] || 4.85,
      };

      // ── SOFR ──────────────────────────────────────────────────────────────
      const sofr     = sofrData.status === "fulfilled" ? sofrData.value.rate : 3.65;
      const sofrDate = sofrData.status === "fulfilled" ? sofrData.value.date : "";

      // ── Live basis from Crypto.com quarterly futures ──────────────────────
      const basisLive    = basisData.status === "fulfilled" ? basisData.value : null;
      const btcBasis     = basisLive?.btcBasis ?? null;
      const ethBasis     = basisLive?.ethBasis ?? null;
      const basisExpiry  = basisLive?.basisExpiry ?? "Jun 26, 2026";
      const daysToExpiry = basisLive?.daysToExpiry ?? 96;
      const btcSpotPrice = basisLive?.btcSpot ?? null;
      const ethSpotPrice = basisLive?.ethSpot ?? null;
      const btcFutPrice  = basisLive?.btcFutPrice ?? null;
      const ethFutPrice  = basisLive?.ethFutPrice ?? null;

      // ── Regime detection ──────────────────────────────────────────────────
      const today = new Date();
      const month = today.getMonth() + 1;
      const day   = today.getDate();
      const isFomcWeek = FOMC_DATES_2026.some(([m, d]) => m === month && Math.abs(d - day) <= 1);
      const regime = { ...detectRegime(vix, btcBasis ?? 0, sofr, isFomcWeek), isFomcWeek };

      // ── Strategies ────────────────────────────────────────────────────────
      const strategies = [
        { name: "BTC Basis Carry (3M)",   type: "Crypto Carry",   targetYield: btcBasis, vsSofr: btcBasis !== null ? +(btcBasis - sofr).toFixed(2) : null, risk: "Very Low", liquidity: "High (24/7)", status: "Active" },
        { name: "ETH Basis Carry (3M)",   type: "Crypto Carry",   targetYield: ethBasis, vsSofr: ethBasis !== null ? +(ethBasis - sofr).toFixed(2) : null, risk: "Very Low", liquidity: "High (24/7)", status: "Active" },
        { name: "Ladder Basis (1/4/12w)", type: "Curve Opt.",     targetYield: 8.75,       vsSofr: +(8.75 - sofr).toFixed(2),     risk: "Very Low", liquidity: "Medium",     status: "Active" },
        { name: "1-Month T-Bill (BIL)",   type: "Gov't Bond ETF", targetYield: yc["1M"],   vsSofr: +(yc["1M"] - sofr).toFixed(2), risk: "Very Low", liquidity: "High",       status: "Active" },
        { name: "3-Month T-Bill (SHV)",   type: "Gov't Bond ETF", targetYield: yc["3M"],   vsSofr: +(yc["3M"] - sofr).toFixed(2), risk: "Very Low", liquidity: "High",       status: "Active" },
        { name: "Calendar Carry (1v4w)",  type: "Options Carry",  targetYield: null, vsSofr: null, risk: "Low",    liquidity: "Medium", status: isFomcWeek ? "Inactive (FOMC)" : "Active" },
        { name: "Put Calendar (ATM)",     type: "Options Carry",  targetYield: null, vsSofr: null, risk: "Low",    liquidity: "Medium", status: isFomcWeek ? "Inactive (FOMC)" : "Active" },
        { name: "Event Fade (post-FOMC)", type: "Options Carry",  targetYield: null, vsSofr: null, risk: "Medium", liquidity: "Medium", status: isFomcWeek ? "Watch post-2pm" : "Inactive" },
      ];

      res.json({
        fetchedAt: new Date().toISOString(),
        yieldCurveDate: ycDate,
        sofrDate,
        dataSources: {
          crypto:    crypto.status    === "fulfilled" ? "CoinGecko"    : "fallback",
          equities:  vixData.status   === "fulfilled" ? "Yahoo Finance" : "fallback",
          dxy:       dxyData.status   === "fulfilled" ? "Yahoo Finance" : "fallback",
          yieldCurve: treasury.status === "fulfilled" ? "US Treasury"  : "fallback",
          sofr:      sofrData.status  === "fulfilled" ? "NY Fed"       : "fallback",
          basis:     basisData.status === "fulfilled" ? "Crypto.com"   : "fallback",
        },
        prices: {
          btc:  { price: btcPrice, pct: btcPct,  low: 0, high: 0 },
          eth:  { price: ethPrice, pct: ethPct,  low: 0, high: 0 },
          vix:  { price: vix,      pct: vixPct },
          sp500:{ price: sp500,    pct: sp500Pct },
          dxy:  { price: dxy,      pct: dxyPct },
          btcBasis,
          ethBasis,
          btcSpotPrice,
          ethSpotPrice,
          btcFutPrice,
          ethFutPrice,
          basisExpiry,
          daysToExpiry,
        },

        rates: {
          sofr,
          fedFunds: 3.64,
          fedFundsTarget: "3.50%–3.75%",
          primeRate: 6.75,
          cpiYoY: 4.2,
          pceCore: 2.8,
          nextFomc: "April 28–29, 2026",
          rateOutlook: "Hold through Q1; 1 cut possible in 2026",
        },
        yieldCurve: yc,
        regime,
        strategies,
        sofr,
      });

    } catch (err: any) {
      console.error("Dashboard error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Health check endpoint ─────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });
}
