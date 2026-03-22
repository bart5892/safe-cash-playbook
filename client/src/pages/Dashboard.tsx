import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import {
  TrendingUp, TrendingDown, Minus, RefreshCw, AlertTriangle,
  Activity, DollarSign, BarChart2, Clock, Zap, ChevronDown, ChevronUp,
  Target, BookOpen
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────
interface DashboardData {
  fetchedAt: string;
  yieldCurveDate?: string;
  sofrDate?: string;
  dataSources?: { crypto: string; equities: string; dxy?: string; yieldCurve: string; sofr: string; basis?: string };
  prices: {
    btc: { price: number; change: number; pct: number; low: number; high: number };
    eth: { price: number; change: number; pct: number; low: number; high: number };
    vix: { price: number; pct: number };
    sp500: { price: number; pct: number };
    dxy: { price: number; pct: number };
    btcBasis: number | null;
    ethBasis: number | null;
    btcSpotPrice: number | null;
    ethSpotPrice: number | null;
    btcFutPrice: number | null;
    ethFutPrice: number | null;
    basisExpiry: string;
    daysToExpiry: number;
  };
  rates: {
    sofr: number; fedFunds: number; fedFundsTarget: string; primeRate: number;
    cpiYoY: number; pceCore: number; nextFomc: string; rateOutlook: string;
  };
  yieldCurve: Record<string, number>;
  regime: {
    activeRegime: string; tradeSignal: string; riskLevel: string;
    regimeColor: string; regimeNote: string; isFomcWeek: boolean;
  };
  strategies: Array<{
    name: string; type: string; targetYield: number | null;
    vsSofr: number | null; risk: string; liquidity: string; status: string;
  }>;
  sofr: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(n: number) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtBps(n: number) {
  const bps = Math.round(n * 100);
  return `${bps >= 0 ? "+" : ""}${bps} bps`;
}
function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

const RISK_COLORS: Record<string, string> = {
  "Very Low": "text-emerald-400",
  "Low": "text-teal-400",
  "Medium": "text-amber-400",
  "High": "text-orange-400",
  "Critical": "text-rose-400",
};
const STATUS_COLORS: Record<string, string> = {
  "Active": "text-emerald-400",
  "Inactive (FOMC)": "text-rose-400",
  "Watch post-2pm": "text-amber-400",
  "Inactive": "text-zinc-500",
};

// ── Sub-components ─────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, subColor = "text-zinc-500", valueColor = "text-zinc-100", icon }: {
  label: string; value: string; sub?: string; subColor?: string; valueColor?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">{label}</span>
        {icon && <span className="text-zinc-600">{icon}</span>}
      </div>
      <span className={`text-2xl font-bold tabular-nums ${valueColor}`}>{value}</span>
      {sub && <span className={`text-xs ${subColor} font-medium`}>{sub}</span>}
    </div>
  );
}

function PriceCard({ label, price, pct, low, high, currency = "" }: {
  label: string; price: number; pct: number; low?: number; high?: number; currency?: string;
}) {
  const isUp = pct >= 0;
  const isFlat = Math.abs(pct) < 0.01;
  const color = isFlat ? "text-zinc-400" : isUp ? "text-emerald-400" : "text-rose-400";
  const Icon = isFlat ? Minus : isUp ? TrendingUp : TrendingDown;
  return (
    <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg p-4">
      <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>
        {currency}{typeof price === 'number' && price > 100 ? fmt(price, 0) : fmt(price, 2)}
      </div>
      <div className={`flex items-center gap-1 mt-1 text-xs font-semibold ${color}`}>
        <Icon size={12} />
        <span>{fmtPct(pct)} today</span>
      </div>
      {low !== undefined && high !== undefined && (
        <div className="text-xs text-zinc-600 mt-1">
          {currency}{fmt(low, 0)} – {currency}{fmt(high, 0)}
        </div>
      )}
    </div>
  );
}

function YieldBar({ tenor, yield_, sofr }: { tenor: string; yield_: number; sofr: number }) {
  const spread = yield_ - sofr;
  const isAbove = spread > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-zinc-500 text-center font-medium">{tenor}</div>
      <div className={`text-center font-bold tabular-nums text-sm ${
        yield_ <= 3.72 ? "text-teal-400" : yield_ <= 4.0 ? "text-amber-400" : "text-orange-400"
      }`}>
        {yield_.toFixed(2)}%
      </div>
      <div className={`text-center text-xs font-medium ${isAbove ? "text-emerald-500" : "text-rose-500"}`}>
        {fmtBps(spread)}
      </div>
    </div>
  );
}

// ── Regime Badge ──────────────────────────────────────────────────────────────
function RegimeBadge({ regime }: { regime: DashboardData["regime"] }) {
  const isEvent = regime.riskLevel === "Critical";
  const isMedium = regime.riskLevel === "Medium";

  return (
    <div className={`rounded-lg border p-4 ${
      isEvent
        ? "bg-rose-950/30 border-rose-800/50"
        : isMedium
        ? "bg-amber-950/30 border-amber-800/50"
        : "bg-emerald-950/30 border-emerald-800/50"
    }`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <Zap size={16} className={isEvent ? "text-rose-400" : "text-emerald-400"} />
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Active Regime</div>
            <div className={`font-bold text-sm ${isEvent ? "text-rose-400" : isMedium ? "text-amber-400" : "text-emerald-400"}`}>
              {regime.activeRegime}
            </div>
          </div>
        </div>
        <div className="sm:border-l sm:border-[#2a2927] sm:pl-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Trade Signal</div>
          <div className={`font-bold text-sm ${isEvent ? "text-rose-300" : "text-teal-300"}`}>
            {regime.tradeSignal}
          </div>
        </div>
        <div className="sm:border-l sm:border-[#2a2927] sm:pl-4 flex-1">
          <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Risk Level</div>
          <div className={`font-bold text-sm ${RISK_COLORS[regime.riskLevel] || "text-zinc-300"}`}>
            {regime.riskLevel}
          </div>
        </div>
        <div className="sm:border-l sm:border-[#2a2927] sm:pl-4 flex-1">
          <div className="text-xs text-zinc-500 mb-0.5 font-medium">Note</div>
          <div className="text-xs text-zinc-400 leading-relaxed">{regime.regimeNote}</div>
        </div>
      </div>
    </div>
  );
}

// ── Regime Matrix ─────────────────────────────────────────────────────────────
const REGIME_ROWS = [
  { regime: "Macro Event Week", condition: "FOMC within 7 days", trade: "NO SHORT VOL", risk: "Critical" },
  { regime: "Event Fade", condition: "Post-FOMC vol elevated", trade: "Sell 1–2w vol post-event", risk: "Medium" },
  { regime: "Steady Contango", condition: "BTC Basis >6% & curve up", trade: "BTC/ETH Basis Carry", risk: "Very Low" },
  { regime: "Steady Contango", condition: "Basis curve steep (BTC>ETH)", trade: "Ladder Basis (1/4/12w)", risk: "Very Low" },
  { regime: "Front-End Vol Spike", condition: "IV(1w) > IV(4w)+5 & RV+10", trade: "Calendar Carry", risk: "Low" },
  { regime: "Front-End Vol Spike", condition: "Same + skew elevated", trade: "Put Calendar", risk: "Very Low" },
  { regime: "Low Vol Compressed", condition: "IV percentile <30%", trade: "Gamma Scalping", risk: "Low" },
  { regime: "High Vol Regime", condition: "IV >60% across curve", trade: "Back-End Vol Selling", risk: "Medium" },
  { regime: "Dislocated Curve", condition: "CME vs Coinbase spread >1%", trade: "Venue Basis Arb", risk: "Very Low" },
];

// ── Trade Structure Panel ─────────────────────────────────────────────────────
// Calculates detailed structure for each active strategy based on $100k notional
function TradeStructurePanel({ data }: { data: DashboardData }) {
  const { prices, sofr, strategies } = data;
  const NOTIONAL = 100_000;

  const btcSpot  = prices.btcSpotPrice ?? prices.btc.price;
  const ethSpot  = prices.ethSpotPrice ?? prices.eth.price;
  const btcFut   = prices.btcFutPrice;
  const ethFut   = prices.ethFutPrice;
  const btcBasis = prices.btcBasis;
  const ethBasis = prices.ethBasis;
  const expiry   = prices.basisExpiry ?? "Jun 26, 2026";
  const dte      = prices.daysToExpiry ?? 96;

  // Active strategies from live data
  const activeStrategies = strategies.filter(s => s.status === "Active");

  // ── Per-strategy structure builder ──────────────────────────────────────
  interface TradeStructure {
    name: string;
    signal: string;
    type: string;
    color: string;
    legs: { label: string; value: string; note?: string }[];
    notionalBreakdown: { label: string; value: string }[];
    summary: string;
  }

  function buildBtcBasisStructure(): TradeStructure {
    const carryPct = btcBasis ?? 0;
    const annualIncome = NOTIONAL * (carryPct / 100);
    const periodIncome = annualIncome * (dte / 365);
    const btcUnits     = btcSpot > 0 ? (NOTIONAL / btcSpot) : 0;
    const cashCollateral = NOTIONAL;

    return {
      name: "BTC Basis Carry (3M)",
      signal: "Buy BTC Spot / Sell Jun Futures",
      type: "Cash-and-Carry",
      color: "teal",
      legs: [
        { label: "Leg 1 — Buy Spot",    value: `${btcUnits.toFixed(4)} BTC`, note: `@ $${fmt(btcSpot, 0)} spot` },
        { label: "Leg 2 — Sell Futures", value: `${btcUnits.toFixed(4)} BTC futures`, note: `@ $${btcFut ? fmt(btcFut, 0) : "N/A"} · ${expiry}` },
        { label: "DTE",                  value: `${dte} days` },
        { label: "Annualised Basis",     value: `${carryPct.toFixed(2)}%`, note: `${(carryPct - sofr).toFixed(2)}% vs SOFR` },
      ],
      notionalBreakdown: [
        { label: "Cash Deployed",     value: `$${fmt(cashCollateral, 0)}` },
        { label: "Period Carry",      value: `~$${fmt(periodIncome, 0)} (${dte}d)` },
        { label: "Annualised P&L",    value: `~$${fmt(annualIncome, 0)} / yr` },
        { label: "BTC Units",         value: `${btcUnits.toFixed(4)} BTC` },
      ],
      summary: `Buy ${btcUnits.toFixed(4)} BTC spot at $${fmt(btcSpot, 0)}, simultaneously sell ${btcUnits.toFixed(4)} BTC Jun 26 futures at $${btcFut ? fmt(btcFut, 0) : "~"} locking in ~${carryPct.toFixed(2)}% annualised carry on $${fmt(cashCollateral, 0)} notional.`,
    };
  }

  function buildEthBasisStructure(): TradeStructure {
    const carryPct = ethBasis ?? 0;
    const annualIncome = NOTIONAL * (carryPct / 100);
    const periodIncome = annualIncome * (dte / 365);
    const ethUnits     = ethSpot > 0 ? (NOTIONAL / ethSpot) : 0;

    return {
      name: "ETH Basis Carry (3M)",
      signal: "Buy ETH Spot / Sell Jun Futures",
      type: "Cash-and-Carry",
      color: "teal",
      legs: [
        { label: "Leg 1 — Buy Spot",     value: `${ethUnits.toFixed(2)} ETH`,          note: `@ $${fmt(ethSpot, 0)} spot` },
        { label: "Leg 2 — Sell Futures",  value: `${ethUnits.toFixed(2)} ETH futures`, note: `@ $${ethFut ? fmt(ethFut, 0) : "N/A"} · ${expiry}` },
        { label: "DTE",                   value: `${dte} days` },
        { label: "Annualised Basis",      value: `${carryPct.toFixed(2)}%`, note: `${(carryPct - sofr).toFixed(2)}% vs SOFR` },
      ],
      notionalBreakdown: [
        { label: "Cash Deployed",  value: `$${fmt(NOTIONAL, 0)}` },
        { label: "Period Carry",   value: `~$${fmt(periodIncome, 0)} (${dte}d)` },
        { label: "Annualised P&L", value: `~$${fmt(annualIncome, 0)} / yr` },
        { label: "ETH Units",      value: `${ethUnits.toFixed(2)} ETH` },
      ],
      summary: `Buy ${ethUnits.toFixed(2)} ETH spot at $${fmt(ethSpot, 0)}, sell ${ethUnits.toFixed(2)} ETH Jun 26 futures at $${ethFut ? fmt(ethFut, 0) : "~"} locking in ~${carryPct.toFixed(2)}% annualised carry on $${fmt(NOTIONAL, 0)} notional.`,
    };
  }

  function buildCalendarCarryStructure(): TradeStructure {
    // Calendar spread: sell 1-week ATM, buy 4-week ATM
    // Typical structure: sell near-term vol premium, buy further vol for hedge
    const atmStrikeBtc = Math.round(btcSpot / 1000) * 1000; // round to nearest $1k
    const atmStrikeEth = Math.round(ethSpot / 10) * 10;       // round to nearest $10

    // Target premium: ~2% of notional per month net (illustrative)
    const grossPremiumEst = NOTIONAL * 0.018; // ~1.8% of notional collected upfront
    const hedgeCostEst    = NOTIONAL * 0.008; // ~0.8% cost for long 4w leg
    const netPremium      = grossPremiumEst - hedgeCostEst;
    const maxProfit       = netPremium;
    const maxLoss         = hedgeCostEst; // if 1w expires worthless and we close 4w at cost

    const expiry1w = (() => {
      const d = new Date(); d.setDate(d.getDate() + 7);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    })();
    const expiry4w = (() => {
      const d = new Date(); d.setDate(d.getDate() + 28);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    })();

    return {
      name: "Calendar Carry (1v4w)",
      signal: "Sell 1-week ATM / Buy 4-week ATM",
      type: "Options Calendar Spread",
      color: "amber",
      legs: [
        { label: "Leg 1 — Sell Short",  value: `BTC $${fmt(atmStrikeBtc, 0)} Call (1w)`,  note: `Expiry: ${expiry1w}` },
        { label: "Leg 2 — Buy Hedge",   value: `BTC $${fmt(atmStrikeBtc, 0)} Call (4w)`,  note: `Expiry: ${expiry4w}` },
        { label: "Alt: ETH strikes",    value: `ETH $${fmt(atmStrikeEth, 0)} ATM`, note: "Same structure on ETH" },
        { label: "IV Edge Target",      value: "Sell near > Buy far IV", note: "Positive theta trade" },
      ],
      notionalBreakdown: [
        { label: "Gross Premium Rcvd",  value: `~$${fmt(grossPremiumEst, 0)}` },
        { label: "Long Leg Cost",       value: `~$${fmt(hedgeCostEst, 0)}` },
        { label: "Net Credit",          value: `~$${fmt(netPremium, 0)}` },
        { label: "Max Profit",          value: `~$${fmt(maxProfit, 0)} (at expiry)` },
        { label: "Max Loss",            value: `~$${fmt(maxLoss, 0)} (move through strike)` },
      ],
      summary: `Sell BTC $${fmt(atmStrikeBtc, 0)} ATM call expiring ${expiry1w}, buy same strike call expiring ${expiry4w}. Net ~$${fmt(netPremium, 0)} credit on $${fmt(NOTIONAL, 0)} notional. Profit if BTC stays near ATM over 7 days.`,
    };
  }

  function buildPutCalendarStructure(): TradeStructure {
    // Put calendar: sell 1w downside put, buy 4w same-strike put (net debit or small credit)
    const atmStrikeBtc = Math.round(btcSpot / 1000) * 1000;
    const ootmStrikeBtc = Math.round(btcSpot * 0.95 / 1000) * 1000; // 5% OTM put

    const expiry1w = (() => {
      const d = new Date(); d.setDate(d.getDate() + 7);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    })();
    const expiry4w = (() => {
      const d = new Date(); d.setDate(d.getDate() + 28);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    })();

    const grossPremiumEst = NOTIONAL * 0.014;
    const hedgeCostEst    = NOTIONAL * 0.006;
    const netCredit       = grossPremiumEst - hedgeCostEst;

    return {
      name: "Put Calendar (ATM)",
      signal: "Sell 1-week Put / Buy 4-week Put",
      type: "Downside Calendar Spread",
      color: "amber",
      legs: [
        { label: "Leg 1 — Sell Short",  value: `BTC $${fmt(ootmStrikeBtc, 0)} Put (1w)`,  note: `Strike ~5% OTM · Expiry ${expiry1w}` },
        { label: "Leg 2 — Buy Hedge",   value: `BTC $${fmt(ootmStrikeBtc, 0)} Put (4w)`,  note: `Same strike · Expiry ${expiry4w}` },
        { label: "ATM alternative",     value: `BTC $${fmt(atmStrikeBtc, 0)} Put`, note: "Higher premium but more delta" },
        { label: "Skew Edge",           value: "Sell elevated near-term skew", note: "Put skew premium capture" },
      ],
      notionalBreakdown: [
        { label: "Gross Premium Rcvd",  value: `~$${fmt(grossPremiumEst, 0)}` },
        { label: "Long Leg Cost",       value: `~$${fmt(hedgeCostEst, 0)}` },
        { label: "Net Credit",          value: `~$${fmt(netCredit, 0)}` },
        { label: "Max Profit",          value: `~$${fmt(netCredit, 0)} if BTC stays above $${fmt(ootmStrikeBtc, 0)}` },
        { label: "Max Loss",            value: `Limited to net debit if both legs expire worthless` },
      ],
      summary: `Sell BTC $${fmt(ootmStrikeBtc, 0)} put (5% OTM) expiring ${expiry1w}, buy same-strike put expiring ${expiry4w}. Net ~$${fmt(netCredit, 0)} credit. Profits from near-term put skew premium while long put provides tail hedge.`,
    };
  }

  // Map active strategies to trade structures
  const structures: TradeStructure[] = [];
  for (const s of activeStrategies) {
    if (s.name.includes("BTC Basis")) structures.push(buildBtcBasisStructure());
    else if (s.name.includes("ETH Basis")) structures.push(buildEthBasisStructure());
    else if (s.name.includes("Calendar Carry")) structures.push(buildCalendarCarryStructure());
    else if (s.name.includes("Put Calendar")) structures.push(buildPutCalendarStructure());
  }

  if (structures.length === 0) {
    return (
      <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg p-6 text-center">
        <p className="text-zinc-500 text-sm">No Active strategies with detailable structure at this time.</p>
        <p className="text-zinc-600 text-xs mt-1">During FOMC weeks, options strategies are paused.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {structures.map((ts, idx) => {
        const borderColor = ts.color === "teal" ? "border-teal-800/40" : "border-amber-800/40";
        const bgColor     = ts.color === "teal" ? "bg-teal-950/20"     : "bg-amber-950/20";
        const accentColor = ts.color === "teal" ? "text-teal-400"      : "text-amber-400";
        const tagBg       = ts.color === "teal" ? "bg-teal-900/40 text-teal-300" : "bg-amber-900/40 text-amber-300";

        return (
          <div key={idx} className={`rounded-lg border ${borderColor} ${bgColor} overflow-hidden`}
            data-testid={`trade-structure-${idx}`}>
            {/* Structure header */}
            <div className="px-4 py-3 border-b border-[#2a2927]/60 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex items-center gap-2 flex-1">
                <Target size={14} className={accentColor} />
                <span className={`font-bold text-sm ${accentColor}`}>{ts.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tagBg}`}>{ts.type}</span>
              </div>
              <div className="text-xs text-zinc-400 font-medium">{ts.signal}</div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-[#2a2927]/50">
              {/* Trade legs */}
              <div className="p-4">
                <div className="text-xs text-zinc-500 uppercase tracking-wider font-semibold mb-3 flex items-center gap-1.5">
                  <BookOpen size={10} /> Trade Legs
                </div>
                <div className="space-y-2.5">
                  {ts.legs.map((leg, li) => (
                    <div key={li} className="flex items-start justify-between gap-3">
                      <span className="text-xs text-zinc-500 shrink-0 mt-0.5 min-w-[120px]">{leg.label}</span>
                      <div className="text-right">
                        <span className={`text-sm font-semibold ${accentColor}`}>{leg.value}</span>
                        {leg.note && <div className="text-xs text-zinc-600 mt-0">{leg.note}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Notional breakdown */}
              <div className="p-4">
                <div className="text-xs text-zinc-500 uppercase tracking-wider font-semibold mb-3 flex items-center gap-1.5">
                  <DollarSign size={10} /> $100k Notional Breakdown
                </div>
                <div className="space-y-2">
                  {ts.notionalBreakdown.map((nb, ni) => (
                    <div key={ni} className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500">{nb.label}</span>
                      <span className="text-sm font-bold tabular-nums text-zinc-200">{nb.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Summary */}
            <div className="px-4 py-3 border-t border-[#2a2927]/60">
              <p className="text-xs text-zinc-400 leading-relaxed">
                <span className="text-zinc-500 font-semibold">Structure: </span>{ts.summary}
              </p>
            </div>
          </div>
        );
      })}

      {/* Disclaimer */}
      <p className="text-xs text-zinc-600 text-center leading-relaxed">
        Premium estimates are indicative. Strikes shown are ATM/near-ATM based on live spot. Always verify with your exchange before executing. Not financial advice.
      </p>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [lastRefresh, setLastRefresh] = useState<string>(new Date().toISOString());
  const [tick, setTick] = useState(0);
  const [showTradeStructures, setShowTradeStructures] = useState(true);

  const { data, isLoading, isFetching, refetch, error } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard"],
    queryFn: () => apiRequest("GET", "/api/dashboard").then(r => r.json()),
    refetchInterval: 5 * 60 * 1000, // 5 minutes
    staleTime: 4 * 60 * 1000,
  });

  useEffect(() => {
    if (data) setLastRefresh(data.fetchedAt);
  }, [data]);

  // Tick every second for "time ago" counter
  useEffect(() => {
    const t = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Yield curve chart data
  const yieldChartData = data ? Object.entries(data.yieldCurve).map(([tenor, yield_]) => ({
    tenor,
    yield: yield_,
    sofr: data.sofr,
  })) : [];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#171614] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-500 text-sm">Fetching live market data…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#171614] flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="text-rose-400 mx-auto mb-3" size={32} />
          <p className="text-zinc-300 font-medium">Failed to load market data</p>
          <p className="text-zinc-600 text-sm mt-1">Check API connectivity</p>
          <button onClick={() => refetch()} className="mt-4 px-4 py-2 bg-teal-700 hover:bg-teal-600 text-white rounded-lg text-sm transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const d = data;
  const yc = d.yieldCurve;
  const activeCount = d.strategies.filter(s => s.status === "Active").length;

  return (
    <div className="min-h-screen bg-[#171614] text-[#cdccca] font-sans">
      {/* ── Header ── */}
      <header className="bg-[#1c1b19] border-b border-[#2a2927] sticky top-0 z-20 px-4 md:px-8 py-3">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* SVG Logo */}
            <svg viewBox="0 0 32 32" width="28" height="28" fill="none" aria-label="Safe Cash Playbook">
              <rect x="2" y="8" width="28" height="18" rx="3" stroke="#4f98a3" strokeWidth="2"/>
              <path d="M10 8V6a6 6 0 0 1 12 0v2" stroke="#4f98a3" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="16" cy="17" r="3" fill="#4f98a3"/>
              <path d="M16 20v2" stroke="#4f98a3" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <div>
              <h1 className="font-bold text-sm text-zinc-100 leading-tight tracking-tight">Safe Cash Playbook</h1>
              <p className="text-xs text-zinc-600 leading-tight">Market Environment Dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 text-xs text-zinc-500">
              <Clock size={12} />
              <span>Updated {timeAgo(lastRefresh)}</span>
              {isFetching && <div className="w-3 h-3 border border-teal-500 border-t-transparent rounded-full animate-spin ml-1" />}
            </div>
            <div className="bg-[#252421] border border-[#393836] px-3 py-1 rounded-full">
              <span className="text-xs text-zinc-500 mr-1">SOFR</span>
              <span className="text-sm font-bold text-teal-400 tabular-nums">{d.sofr.toFixed(2)}%</span>
            </div>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252421] hover:bg-[#2e2c2a] border border-[#393836] rounded-lg text-xs text-zinc-400 transition-colors disabled:opacity-50"
              data-testid="button-refresh"
            >
              <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 md:px-8 py-6 space-y-6">
        {/* ── Regime Banner ── */}
        <RegimeBadge regime={d.regime} />

        {/* ── Market Conditions ── */}
        <section>
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Activity size={12} /> Market Conditions — Live
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            <PriceCard label="BTC / USD"  price={d.prices.btc.price}   pct={d.prices.btc.pct}   low={d.prices.btc.low}   high={d.prices.btc.high}   currency="$" />
            <PriceCard label="ETH / USD"  price={d.prices.eth.price}   pct={d.prices.eth.pct}   low={d.prices.eth.low}   high={d.prices.eth.high}   currency="$" />
            <KpiCard label="VIX" value={d.prices.vix.price.toFixed(2)}
              sub={fmtPct(d.prices.vix.pct) + " today"}
              valueColor={d.prices.vix.price > 30 ? "text-rose-400" : d.prices.vix.price > 20 ? "text-amber-400" : "text-emerald-400"}
              subColor={d.prices.vix.pct >= 0 ? "text-rose-500" : "text-emerald-500"}
              icon={<BarChart2 size={14} />}
            />
            <KpiCard label="S&P 500" value={fmt(d.prices.sp500.price, 0)}
              sub={fmtPct(d.prices.sp500.pct) + " today"}
              subColor={d.prices.sp500.pct >= 0 ? "text-emerald-500" : "text-rose-500"}
              icon={<TrendingUp size={14} />}
            />
            {/* DXY — Dollar Index */}
            <KpiCard
              label="DXY (USD Index)"
              value={d.prices.dxy?.price ? fmt(d.prices.dxy.price, 2) : "—"}
              sub={d.prices.dxy?.pct !== undefined ? fmtPct(d.prices.dxy.pct) + " today" : ""}
              valueColor={
                d.prices.dxy?.price > 105 ? "text-rose-400" :
                d.prices.dxy?.price < 100 ? "text-emerald-400" :
                "text-amber-400"
              }
              subColor={d.prices.dxy?.pct >= 0 ? "text-rose-500" : "text-emerald-500"}
              icon={<DollarSign size={14} />}
            />
            <KpiCard label="BTC Basis (3M est.)" value={`~${d.prices.btcBasis?.toFixed(1) ?? "—"}%`}
              sub={d.prices.btcBasis !== null ? `+${(d.prices.btcBasis - d.sofr).toFixed(1)}% vs SOFR` : "Live basis"}
              valueColor="text-teal-400" subColor="text-emerald-500"
              icon={<DollarSign size={14} />}
            />
            <KpiCard label="ETH Basis (3M est.)" value={`~${d.prices.ethBasis?.toFixed(1) ?? "—"}%`}
              sub={d.prices.ethBasis !== null ? `+${(d.prices.ethBasis - d.sofr).toFixed(1)}% vs SOFR` : "Live basis"}
              valueColor="text-teal-400" subColor="text-emerald-500"
              icon={<DollarSign size={14} />}
            />
          </div>
        </section>

        {/* ── Rates & Yield Curve ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Rates Panel */}
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <DollarSign size={12} /> Rates & Benchmark
            </h2>
            <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg divide-y divide-[#232220]">
              {[
                { label: "★ SOFR (Benchmark)", value: `${d.rates.sofr.toFixed(2)}%`, note: "Overnight benchmark", highlight: true },
                { label: "Fed Funds (Eff.)",  value: `${d.rates.fedFunds.toFixed(2)}%`, note: `Target ${d.rates.fedFundsTarget}` },
                { label: "1-Month T-Bill",    value: `${yc["1M"]?.toFixed(2)}%`, note: `${fmtBps(yc["1M"] - d.rates.sofr)} vs SOFR` },
                { label: "3-Month T-Bill",    value: `${yc["3M"]?.toFixed(2)}%`, note: `${fmtBps(yc["3M"] - d.rates.sofr)} vs SOFR` },
                { label: "2-Year Treasury",   value: `${yc["2Y"]?.toFixed(2)}%`, note: `${fmtBps(yc["2Y"] - d.rates.sofr)} vs SOFR` },
                { label: "10-Year Treasury",  value: `${yc["10Y"]?.toFixed(2)}%`, note: `${fmtBps(yc["10Y"] - d.rates.sofr)} vs SOFR` },
                { label: "Prime Rate",        value: `${d.rates.primeRate.toFixed(2)}%`, note: "Fed Funds + 300bps" },
              ].map(({ label, value, note, highlight }) => (
                <div key={label} className={`flex items-center justify-between px-4 py-2.5 ${highlight ? "bg-teal-950/20" : ""}`}>
                  <span className={`text-sm ${highlight ? "text-teal-300 font-semibold" : "text-zinc-400"}`}>{label}</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${highlight ? "text-teal-400" : "text-zinc-200"}`}>{value}</span>
                    <span className="text-xs text-zinc-600 ml-2">{note}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Yield Curve Chart */}
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <BarChart2 size={12} /> Yield Curve — US Treasury
            </h2>
            <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs text-zinc-500">Normal / Upward Sloping · 2Y–10Y: {fmtBps(yc["10Y"] - yc["2Y"])}</div>
                <div className="text-xs text-emerald-500 font-medium">As of {d.yieldCurveDate || "2026-03-16"}</div>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={yieldChartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2927" />
                  <XAxis dataKey="tenor" tick={{ fill: "#797876", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis domain={["auto", "auto"]} tick={{ fill: "#797876", fontSize: 11 }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => `${v.toFixed(2)}%`} />
                  <Tooltip
                    contentStyle={{ background: "#1c1b19", border: "1px solid #393836", borderRadius: "8px", padding: "8px 12px" }}
                    labelStyle={{ color: "#797876", fontSize: 11 }}
                    itemStyle={{ color: "#4f98a3", fontSize: 12, fontWeight: 600 }}
                    formatter={(v: number) => [`${v.toFixed(2)}%`, "Yield"]}
                  />
                  <ReferenceLine y={d.rates.sofr} stroke="#4f98a3" strokeDasharray="4 4" strokeOpacity={0.5}
                    label={{ value: `SOFR ${d.rates.sofr}%`, fill: "#4f98a3", fontSize: 10, position: "insideTopRight" }} />
                  <Line type="monotone" dataKey="yield" stroke="#4f98a3" strokeWidth={2}
                    dot={{ fill: "#4f98a3", r: 4, strokeWidth: 0 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
              {/* Tenor strip */}
              <div className="grid grid-cols-7 gap-1 mt-3 pt-3 border-t border-[#232220]">
                {Object.entries(yc).map(([tenor, yield_]) => (
                  <YieldBar key={tenor} tenor={tenor} yield_={yield_} sofr={d.sofr} />
                ))}
              </div>
            </div>
          </section>
        </div>

        {/* ── Macro Environment ── */}
        <section>
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Activity size={12} /> Macro Environment
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Fed Rate Target" value={d.rates.fedFundsTarget} sub="Unchanged since Dec 2025" valueColor="text-zinc-200" />
            <KpiCard label="CPI (Feb 2026 est.)" value={`~${d.rates.cpiYoY.toFixed(1)}% YoY`} sub="Above Fed 2% target" valueColor="text-orange-400" subColor="text-zinc-500" />
            <KpiCard label="PCE Core (Jan 2026)" value={`~${d.rates.pceCore.toFixed(1)}% YoY`} sub="Fed's preferred gauge" valueColor="text-amber-400" subColor="text-zinc-500" />
            <KpiCard label="Next FOMC" value={d.rates.nextFomc} sub={d.rates.rateOutlook} valueColor="text-zinc-300" subColor="text-zinc-600" />
          </div>
        </section>

        {/* ── Regime Assessment Table ── */}
        <section>
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Zap size={12} /> Regime Assessment — Rules-Based Signal Engine
          </h2>
          <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-teal-900/30 border-b border-[#2a2927]">
                    {["Regime", "Condition", "Status", "Trade Signal", "Risk"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-teal-300 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {REGIME_ROWS.map((row, i) => {
                    const isActive = row.regime === d.regime.activeRegime ||
                      (row.trade === "Event Fade" && d.regime.isFomcWeek) ||
                      (row.regime === "Steady Contango" && (d.prices.btcBasis ?? 0) > 6);
                    const status = row.regime === d.regime.activeRegime && row.risk === d.regime.riskLevel
                      ? "🔴 ACTIVE"
                      : row.regime === "Event Fade" && d.regime.isFomcWeek
                      ? "🟡 WATCH"
                      : isActive
                      ? "🟢 ACTIVE"
                      : "⚪ INACTIVE";
                    const statusColor = status.includes("🔴") ? "text-rose-400 font-bold" :
                      status.includes("🟡") ? "text-amber-400 font-semibold" :
                      status.includes("🟢") ? "text-emerald-400 font-semibold" :
                      "text-zinc-600";
                    return (
                      <tr key={i}
                        className={`border-b border-[#232220] transition-colors ${
                          isActive && row.risk === "Critical" ? "bg-rose-950/20" :
                          isActive ? "bg-emerald-950/10" : "hover:bg-[#201f1d]"
                        }`}
                        data-testid={`row-regime-${i}`}
                      >
                        <td className={`px-4 py-2.5 font-medium text-sm ${
                          row.risk === "Critical" ? "text-rose-400" :
                          row.regime === "Steady Contango" ? "text-emerald-400" :
                          row.risk === "Medium" ? "text-amber-400" : "text-zinc-400"
                        }`}>{row.regime}</td>
                        <td className="px-4 py-2.5 text-zinc-500 text-xs">{row.condition}</td>
                        <td className={`px-4 py-2.5 text-xs ${statusColor}`}>{status}</td>
                        <td className={`px-4 py-2.5 font-medium text-sm ${
                          row.trade === "NO SHORT VOL" ? "text-rose-400" :
                          row.trade.includes("Basis") ? "text-teal-400" : "text-zinc-300"
                        }`}>{row.trade}</td>
                        <td className={`px-4 py-2.5 text-xs font-semibold ${RISK_COLORS[row.risk] || "text-zinc-400"}`}>
                          {row.risk}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Trade Structures Panel (collapsible) ── */}
          <div className="mt-4">
            <button
              onClick={() => setShowTradeStructures(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 bg-[#1c1b19] border border-[#2a2927] rounded-lg hover:bg-[#201f1d] transition-colors group"
              data-testid="button-trade-structures"
            >
              <div className="flex items-center gap-2">
                <Target size={13} className="text-teal-400" />
                <span className="text-sm font-semibold text-zinc-200">Active Trade Structures</span>
                {activeCount > 0 && (
                  <span className="bg-emerald-900/60 text-emerald-400 text-xs font-bold px-2 py-0.5 rounded-full">
                    {activeCount} Active
                  </span>
                )}
                <span className="text-xs text-zinc-600">— Detailed structure · strikes · expiries · $100k notional</span>
              </div>
              {showTradeStructures
                ? <ChevronUp size={14} className="text-zinc-500 group-hover:text-zinc-400 transition-colors" />
                : <ChevronDown size={14} className="text-zinc-500 group-hover:text-zinc-400 transition-colors" />
              }
            </button>

            {showTradeStructures && (
              <div className="mt-3">
                <TradeStructurePanel data={d} />
              </div>
            )}
          </div>
        </section>

        {/* ── SOFR Benchmark Table ── */}
        <section>
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <DollarSign size={12} /> SOFR Benchmark Comparison
          </h2>
          <div className="bg-[#1c1b19] border border-[#2a2927] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#20201e] border-b border-[#2a2927]">
                    {["Strategy", "Type", "Target Yield", "vs SOFR", "Risk", "Liquidity", "Status"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* SOFR base row */}
                  <tr className="border-b border-[#2a2927] bg-teal-950/20">
                    <td className="px-4 py-3 font-bold text-teal-400">★ SOFR (Benchmark)</td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">Overnight</td>
                    <td className="px-4 py-3 font-bold text-teal-400 tabular-nums">{d.sofr.toFixed(2)}%</td>
                    <td className="px-4 py-3 font-bold text-teal-400">0.00% BASE</td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">None</td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">Daily</td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">Risk-free baseline</td>
                  </tr>
                  {d.strategies.map((s, i) => (
                    <tr key={i} className={`border-b border-[#232220] hover:bg-[#201f1d] transition-colors`}
                      data-testid={`row-strategy-${i}`}>
                      <td className={`px-4 py-2.5 font-semibold text-sm ${
                        s.status === "Active" ? "text-emerald-400" :
                        s.status.includes("Inactive") ? "text-zinc-500" :
                        "text-amber-400"
                      }`}>{s.name}</td>
                      <td className="px-4 py-2.5 text-zinc-500 text-xs">{s.type}</td>
                      <td className="px-4 py-2.5 font-bold tabular-nums text-zinc-200">
                        {s.targetYield != null ? `${s.targetYield.toFixed(2)}%` : "Conditional"}
                      </td>
                      <td className={`px-4 py-2.5 font-bold tabular-nums text-sm ${
                        s.vsSofr != null && s.vsSofr > 0 ? "text-emerald-400" :
                        s.vsSofr != null && s.vsSofr < 0 ? "text-rose-400" :
                        "text-amber-400"
                      }`}>
                        {s.vsSofr != null ? fmtPct(s.vsSofr) : "Conditional"}
                      </td>
                      <td className={`px-4 py-2.5 text-xs font-semibold ${RISK_COLORS[s.risk] || ""}`}>{s.risk}</td>
                      <td className="px-4 py-2.5 text-zinc-400 text-xs">{s.liquidity}</td>
                      <td className={`px-4 py-2.5 text-xs font-semibold ${STATUS_COLORS[s.status] || "text-zinc-400"}`}>
                        {s.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Footer ── */}
        <footer className="border-t border-[#2a2927] pt-4 pb-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div className="text-xs text-zinc-600 space-y-0.5">
            <p>
              Crypto: {d.dataSources?.crypto ?? "CoinGecko"} · Equities/DXY: {d.dataSources?.equities ?? "Yahoo Finance"} · Yields: {d.dataSources?.yieldCurve ?? "US Treasury"} · SOFR: {d.dataSources?.sofr ?? "NY Fed"} · Futures: {d.dataSources?.basis ?? "Crypto.com"}
            </p>
            <p>Auto-refreshes every 5 minutes · Last updated: {new Date(lastRefresh).toLocaleTimeString()}</p>
          </div>
          <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer"
            className="text-xs text-zinc-700 hover:text-zinc-500 transition-colors shrink-0">
            Created with Perplexity Computer
          </a>
        </footer>
      </main>
    </div>
  );
}
