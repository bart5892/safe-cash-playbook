// Vercel serverless function — all API logic lives here
// No keys required: CoinGecko + Yahoo Finance + US Treasury + NY Fed

async function fetchJSON(url, headers = {}) {
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

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

async function fetchCryptoPrices() {
  const data = await fetchJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true"
  );
  return {
    btcPrice: data.bitcoin?.usd ?? 0,
    ethPrice: data.ethereum?.usd ?? 0,
    btcPct:   data.bitcoin?.usd_24h_change ?? 0,
    ethPct:   data.ethereum?.usd_24h_change ?? 0,
  };
}

// ── Crypto.com — live futures basis (3-month, annualised) ─────────────────────
// Uses the June quarterly futures vs spot to compute real carry
async function fetchFuturesBasis() {
  // Crypto.com Exchange v1 public API — June 2026 quarterly futures vs spot
  const BASE = "https://api.crypto.com/exchange/v1/public";

  async function getQuote(instrument) {
    const data = await fetchJSON(`${BASE}/get-tickers?instrument_name=${instrument}`);
    const t = data?.result?.data?.[0] ?? {};
    const bid  = parseFloat(t.b ?? 0);
    const ask  = parseFloat(t.k ?? 0);
    const last = parseFloat(t.a ?? 0);
    const mid  = (bid > 0 && ask > 0) ? (bid + ask) / 2 : last;
    return { mid, last };
  }

  const [btcSpotQ, btcFutQ, ethSpotQ, ethFutQ] = await Promise.all([
    getQuote("BTC_USD"),
    getQuote("BTCUSD-260626"),
    getQuote("ETH_USD"),
    getQuote("ETHUSD-260626"),
  ]);

  // Days to June 26 expiry
  const today = new Date();
  const expiry = new Date("2026-06-26");
  const daysToExpiry = Math.max(1, Math.round((expiry - today) / 86400000));

  function annualisedBasis(spot, futures) {
    if (!spot || !futures) return null;
    return ((futures - spot) / spot) * (365 / daysToExpiry) * 100;
  }

  const btcBasis = annualisedBasis(btcSpotQ.mid || btcSpotQ.last, btcFutQ.mid || btcFutQ.last);
  const ethBasis = annualisedBasis(ethSpotQ.mid || ethSpotQ.last, ethFutQ.mid || ethFutQ.last);

  return {
    btcBasis:        btcBasis !== null ? +btcBasis.toFixed(2) : null,
    ethBasis:        ethBasis !== null ? +ethBasis.toFixed(2) : null,
    basisExpiry:     "Jun 26, 2026",
    daysToExpiry,
    btcSpot:         btcSpotQ.mid || btcSpotQ.last,
    btcFutures:      btcFutQ.mid  || btcFutQ.last,
    ethSpot:         ethSpotQ.mid || ethSpotQ.last,
    ethFutures:      ethFutQ.mid  || ethFutQ.last,
  };
}

async function fetchYahooQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const data = await fetchJSON(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`
  );
  const meta = data?.chart?.result?.[0]?.meta ?? {};
  const price = meta.regularMarketPrice ?? 0;
  const prev  = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const pct   = prev ? ((price - prev) / prev) * 100 : 0;
  return { price, prev, pct };
}

async function fetchTreasuryYieldCurve() {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/${yyyymm}?type=daily_treasury_yield_curve&field_tdr_date_value=${yyyymm}`;
  const csv = await fetchText(url);
  const lines = csv.trim().split("\n").filter(Boolean);
  if (lines.length < 2) throw new Error("Empty yield curve CSV");
  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  const latest  = lines[1].split(",").map(v => v.replace(/"/g, "").trim());
  const yields  = {};
  headers.forEach((h, i) => { if (h !== "Date" && latest[i]) yields[h] = parseFloat(latest[i]) || 0; });
  return { date: latest[0], yields };
}

async function fetchSOFR() {
  const data = await fetchJSON("https://markets.newyorkfed.org/api/rates/secured/sofr/last/3.json");
  const latest = (data?.refRates ?? [])[0];
  return { rate: latest?.percentRate ?? 3.65, date: latest?.effectiveDate ?? "" };
}

const FOMC_DATES_2026 = [
  [3,17],[3,18],[4,28],[4,29],[6,16],[6,17],
  [7,28],[7,29],[9,15],[9,16],[10,27],[10,28],[12,8],[12,9],
];

function detectRegime(vix, btcBasis, sofr, isFomcWeek) {
  if (isFomcWeek)  return { activeRegime: "Macro Event Week",         tradeSignal: "NO SHORT VOL",         riskLevel: "Critical",  regimeColor: "error",   regimeNote: "FOMC decision window. Avoid new short-vol. Watch for Event Fade post-announcement." };
  if (vix > 30)    return { activeRegime: "High Vol Regime",           tradeSignal: "Back-End Vol Selling", riskLevel: "Medium",    regimeColor: "warning", regimeNote: `VIX ${vix.toFixed(1)} — elevated. Sell 8–12w / buy wings.` };
  if (vix < 16)    return { activeRegime: "Low Vol / Compressed Surface", tradeSignal: "Gamma Scalping",   riskLevel: "Low",       regimeColor: "primary", regimeNote: `VIX ${vix.toFixed(1)} — compressed. Gamma scalping setup.` };
  return           { activeRegime: "Steady Contango Vol Curve",        tradeSignal: "BTC/ETH Basis Carry", riskLevel: "Very Low",  regimeColor: "success", regimeNote: `BTC basis ~${btcBasis.toFixed(1)}% (+${(btcBasis - sofr).toFixed(1)}% vs SOFR). Core carry active.` };
}

export default async function handler(req, res) {
  // CORS for any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  try {
    const [crypto, vixData, sp500Data, treasury, sofrData] = await Promise.allSettled([
      fetchCryptoPrices(),
      fetchYahooQuote("^VIX"),
      fetchYahooQuote("^GSPC"),
      fetchTreasuryYieldCurve(),
      fetchSOFR(),
    ]);

    const btcPrice = crypto.status === "fulfilled" ? crypto.value.btcPrice : 72000;
    const ethPrice = crypto.status === "fulfilled" ? crypto.value.ethPrice : 2200;
    const btcPct   = crypto.status === "fulfilled" ? crypto.value.btcPct   : 0;
    const ethPct   = crypto.status === "fulfilled" ? crypto.value.ethPct   : 0;

    const vix      = vixData.status === "fulfilled" ? vixData.value.price  : 20;
    const vixPct   = vixData.status === "fulfilled" ? vixData.value.pct    : 0;
    const sp500    = sp500Data.status === "fulfilled" ? sp500Data.value.price : 6700;
    const sp500Pct = sp500Data.status === "fulfilled" ? sp500Data.value.pct   : 0;

    const ycRaw    = treasury.status === "fulfilled" ? treasury.value.yields : {};
    const ycDate   = treasury.status === "fulfilled" ? treasury.value.date   : "N/A";

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

    const sofr     = sofrData.status === "fulfilled" ? sofrData.value.rate  : 3.65;
    const sofrDate = sofrData.status === "fulfilled" ? sofrData.value.date  : "";

    const btcBasis = 8.2;
    const ethBasis = 6.5;

    const today      = new Date();
    const month      = today.getMonth() + 1;
    const day        = today.getDate();
    const isFomcWeek = FOMC_DATES_2026.some(([m, d]) => m === month && Math.abs(d - day) <= 1);
    const regime     = { ...detectRegime(vix, btcBasis, sofr, isFomcWeek), isFomcWeek };

    const strategies = [
      { name: "BTC Basis Carry (3M)",   type: "Crypto Carry",   targetYield: btcBasis, vsSofr: +(btcBasis - sofr).toFixed(2), risk: "Very Low", liquidity: "High (24/7)", status: "Active" },
      { name: "ETH Basis Carry (3M)",   type: "Crypto Carry",   targetYield: ethBasis, vsSofr: +(ethBasis - sofr).toFixed(2), risk: "Very Low", liquidity: "High (24/7)", status: "Active" },
      { name: "Ladder Basis (1/4/12w)", type: "Curve Opt.",     targetYield: 8.75,     vsSofr: +(8.75 - sofr).toFixed(2),    risk: "Very Low", liquidity: "Medium",      status: "Active" },
      { name: "1-Month T-Bill (BIL)",   type: "Gov't Bond ETF", targetYield: yc["1M"], vsSofr: +(yc["1M"] - sofr).toFixed(2),risk: "Very Low", liquidity: "High",        status: "Active" },
      { name: "3-Month T-Bill (SHV)",   type: "Gov't Bond ETF", targetYield: yc["3M"], vsSofr: +(yc["3M"] - sofr).toFixed(2),risk: "Very Low", liquidity: "High",        status: "Active" },
      { name: "Calendar Carry (1v4w)",  type: "Options Carry",  targetYield: null, vsSofr: null, risk: "Low",    liquidity: "Medium", status: isFomcWeek ? "Inactive (FOMC)" : "Active" },
      { name: "Put Calendar (ATM)",     type: "Options Carry",  targetYield: null, vsSofr: null, risk: "Low",    liquidity: "Medium", status: isFomcWeek ? "Inactive (FOMC)" : "Active" },
      { name: "Event Fade (post-FOMC)", type: "Options Carry",  targetYield: null, vsSofr: null, risk: "Medium", liquidity: "Medium", status: isFomcWeek ? "Watch post-2pm"  : "Inactive" },
    ];

    res.status(200).json({
      fetchedAt: new Date().toISOString(),
      yieldCurveDate: ycDate,
      sofrDate,
      dataSources: {
        crypto:    crypto.status    === "fulfilled" ? "CoinGecko"    : "fallback",
        equities:  vixData.status   === "fulfilled" ? "Yahoo Finance" : "fallback",
        yieldCurve: treasury.status === "fulfilled" ? "US Treasury"  : "fallback",
        sofr:      sofrData.status  === "fulfilled" ? "NY Fed"       : "fallback",
        basis:     basisData.status === "fulfilled" ? "Crypto.com"   : "fallback",
      },
      prices: {
        btc:   { price: btcPrice, pct: btcPct },
        eth:   { price: ethPrice, pct: ethPct },
        vix:   { price: vix,      pct: vixPct },
        sp500: { price: sp500,    pct: sp500Pct },
        btcBasis,
        ethBasis,
        btcFutPrice,
        ethFutPrice,
        basisExpiry,
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
  } catch (err) {
    console.error("Dashboard error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
