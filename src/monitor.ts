// Fruma monitor — Morpho Blue market + borrower discovery, health math, shadow-logging.
// Ports SharaPova's monitor architecture: chunked log bootstrap, disk cache, Multicall3
// batch health checks, hot-tier prioritization. Morpho difference: health is PER MARKET
// (position math), not a global getUserAccountData.
import * as fs from "fs";
import * as path from "path";
import { Contract, Interface, AbiCoder, getAddress } from "ethers";
import {
  MORPHO, MORPHO_ABI, ORACLE_ABI, ERC20_ABI, MULTICALL3, MULTICALL3_ABI,
  TOPIC_CREATE_MARKET, TOPIC_BORROW, TOPIC_LIQUIDATE,
  ORACLE_PRICE_SCALE, WAD, lifWad,
} from "./config";
import { withRetry, withLogsRetry } from "./rpc";
import { log, warn, shadow } from "./utils/logger";

const abi = AbiCoder.defaultAbiCoder();
const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CACHE_FILE = path.join(DATA_DIR, "state.json");

const LOG_CHUNK = 900; // getLogs block-range per request (Alchemy free tier friendly)
const HOT_LTV = 0.95; // fraction of LLTV → "hot" tier, checked every cycle
const BATCH = 60; // multicall batch size

export interface Market {
  id: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint; // WAD
  loanSymbol?: string;
  collSymbol?: string;
  loanDecimals?: number;
}

interface State {
  scannedTo: number; // last block fully scanned for events
  markets: Record<string, Omit<Market, "lltv"> & { lltv: string }>;
  borrowers: Record<string, string[]>; // marketId -> borrower addresses
}

export interface AtRisk {
  market: Market;
  borrower: string;
  borrowShares: bigint;
  collateral: bigint;
  debtAssets: bigint; // loan-token units
  ltvBps: number; // current LTV in bps of LLTV (10000 = at liquidation line)
}

let state: State = { scannedTo: 0, markets: {}, borrowers: {} };
const hotSet = new Set<string>(); // "marketId:borrower" keys checked every cycle
let normalCursor = 0;

function saveState(): void {
  const tmp = CACHE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, CACHE_FILE);
}

function loadState(): void {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (parsed && typeof parsed.scannedTo === "number") state = parsed;
    }
  } catch {
    warn("state.json unreadable — starting fresh");
  }
}

export function markets(): Market[] {
  return Object.values(state.markets).map((m) => ({ ...m, lltv: BigInt(m.lltv) }));
}

export function borrowerCount(): number {
  return Object.values(state.borrowers).reduce((a, b) => a + b.length, 0);
}

// ── Event scanning ────────────────────────────────────────────────────────────

// Markets created before our lookback window: fetch params directly from chain.
async function backfillMarket(marketId: string): Promise<void> {
  try {
    const morpho = new Contract(MORPHO, MORPHO_ABI, undefined);
    const [loanToken, collateralToken, oracle, irm, lltv] = await withRetry((p) =>
      (morpho.connect(p) as Contract).idToMarketParams(marketId)
    );
    if (loanToken === "0x0000000000000000000000000000000000000000") return;
    state.markets[marketId] = {
      id: marketId, loanToken, collateralToken, oracle, irm, lltv: lltv.toString(),
    };
    if (!state.borrowers[marketId]) state.borrowers[marketId] = [];
    log(`market backfilled ${marketId.slice(0, 10)}… lltv=${Number(lltv) / 1e16}%`);
  } catch {
    /* transient RPC issue — next Borrow event on this market retries */
  }
}

async function scanRange(from: number, to: number): Promise<void> {
  const logs = await withLogsRetry((p) =>
    p.getLogs({
      address: MORPHO,
      fromBlock: from,
      toBlock: to,
      topics: [[TOPIC_CREATE_MARKET, TOPIC_BORROW, TOPIC_LIQUIDATE]],
    })
  );

  for (const l of logs) {
    const marketId = l.topics[1];
    if (l.topics[0] === TOPIC_CREATE_MARKET) {
      const [loanToken, collateralToken, oracle, irm, lltv] = abi.decode(
        ["address", "address", "address", "address", "uint256"],
        l.data
      );
      state.markets[marketId] = {
        id: marketId, loanToken, collateralToken, oracle, irm, lltv: lltv.toString(),
      };
      if (!state.borrowers[marketId]) state.borrowers[marketId] = [];
      log(`market discovered ${marketId.slice(0, 10)}… lltv=${Number(lltv) / 1e16}%`);
    } else if (l.topics[0] === TOPIC_BORROW) {
      // Borrow(id, caller, onBehalf(indexed), receiver, assets, shares)
      const onBehalf = getAddress("0x" + l.topics[3].slice(26));
      const list = (state.borrowers[marketId] ??= []);
      if (!list.includes(onBehalf)) list.push(onBehalf);
      // Market created before our lookback window? Backfill its params from chain.
      if (!state.markets[marketId]) await backfillMarket(marketId);
    } else if (l.topics[0] === TOPIC_LIQUIDATE) {
      // Shadow-log every real liquidation: who won, how big. Phase 1's core output.
      const caller = getAddress("0x" + l.topics[2].slice(26));
      const borrower = getAddress("0x" + l.topics[3].slice(26));
      const [repaidAssets, , seizedAssets] = abi.decode(
        ["uint256", "uint256", "uint256", "uint256", "uint256"],
        l.data
      );
      shadow({
        type: "observed_liquidation",
        block: l.blockNumber, tx: l.transactionHash,
        marketId, winner: caller, borrower,
        repaidAssets: repaidAssets.toString(),
        seizedAssets: seizedAssets.toString(),
        wasOnOurHotlist: hotSet.has(`${marketId}:${borrower}`),
      });
      log(`LIQUIDATION observed: winner ${caller.slice(0, 8)}… borrower ${borrower.slice(0, 8)}… (hotlisted=${hotSet.has(`${marketId}:${borrower}`)})`);
    }
  }
}

export async function bootstrap(deployBlock: number, deadlineMs = 0): Promise<void> {
  loadState();
  const head = await withRetry((p) => p.getBlockNumber());
  let from = Math.max(state.scannedTo + 1, deployBlock);
  if (from >= head) { log("bootstrap: cache is current"); return; }

  log(`bootstrap: scanning blocks ${from}→${head} (${head - from} blocks, chunk ${LOG_CHUNK})`);
  while (from <= head) {
    if (deadlineMs > 0 && Date.now() > deadlineMs) {
      warn(`bootstrap deadline hit at block ${from} — saving progress, will resume next run`);
      break;
    }
    const to = Math.min(from + LOG_CHUNK - 1, head);
    await scanRange(from, to);
    state.scannedTo = to;
    from = to + 1;
    if (to % (LOG_CHUNK * 20) < LOG_CHUNK) saveState(); // periodic checkpoint
  }
  saveState();
  // repair pass: any market we hold borrowers for but never saw created
  for (const id of Object.keys(state.borrowers)) {
    if (!state.markets[id]) await backfillMarket(id);
  }
  saveState();
  await enrichMarkets();
  log(`bootstrap done: ${markets().length} markets, ${borrowerCount()} borrowers`);
}

export async function pollNewEvents(): Promise<void> {
  const head = await withRetry((p) => p.getBlockNumber());
  if (head <= state.scannedTo) return;
  // clamp: if we somehow fell far behind, don't hammer the RPC catching up all at once
  let from = state.scannedTo + 1;
  if (head - from > 50_000) {
    warn(`cursor ${head - from} blocks behind — clamping`);
    from = head - 50_000;
  }
  while (from <= head) {
    const to = Math.min(from + LOG_CHUNK - 1, head);
    await scanRange(from, to);
    state.scannedTo = to;
    from = to + 1;
  }
  saveState();
}

// ── Token metadata (symbols/decimals for readable logs) ───────────────────────

async function enrichMarkets(): Promise<void> {
  for (const m of Object.values(state.markets)) {
    if (m.loanSymbol) continue;
    try {
      const loan = new Contract(m.loanToken, ERC20_ABI, undefined);
      const coll = new Contract(m.collateralToken, ERC20_ABI, undefined);
      m.loanSymbol = await withRetry((p) => (loan.connect(p) as Contract).symbol());
      m.collSymbol = await withRetry((p) => (coll.connect(p) as Contract).symbol());
      m.loanDecimals = Number(await withRetry((p) => (loan.connect(p) as Contract).decimals()));
    } catch {
      m.loanSymbol = "?"; m.collSymbol = "?"; m.loanDecimals = 18;
    }
  }
  saveState();
}

// ── Health checks ─────────────────────────────────────────────────────────────

const morphoIface = new Interface(MORPHO_ABI);
const oracleIface = new Interface(ORACLE_ABI);

// Batch-check a set of (market, borrower) pairs; returns positions sorted riskiest-first.
export async function checkHealth(pairs: { market: Market; borrower: string }[]): Promise<AtRisk[]> {
  if (pairs.length === 0) return [];
  const results: AtRisk[] = [];

  // one oracle price + market totals fetch per distinct market in this batch
  const marketIds = [...new Set(pairs.map((p) => p.market.id))];
  const marketData = new Map<string, { price: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint }>();

  const mc = new Contract(MULTICALL3, MULTICALL3_ABI, undefined);
  const headCalls = marketIds.flatMap((id) => {
    const m = pairs.find((p) => p.market.id === id)!.market;
    return [
      { target: m.oracle, allowFailure: true, callData: oracleIface.encodeFunctionData("price") },
      { target: MORPHO, allowFailure: true, callData: morphoIface.encodeFunctionData("market", [id]) },
    ];
  });
  const headRes: { success: boolean; returnData: string }[] = await withRetry((p) =>
    (mc.connect(p) as Contract).aggregate3.staticCall(headCalls)
  );
  marketIds.forEach((id, i) => {
    const priceRes = headRes[i * 2], mktRes = headRes[i * 2 + 1];
    if (!priceRes.success || !mktRes.success) return;
    const price = BigInt(oracleIface.decodeFunctionResult("price", priceRes.returnData)[0]);
    const mkt = morphoIface.decodeFunctionResult("market", mktRes.returnData);
    marketData.set(id, {
      price,
      totalBorrowAssets: BigInt(mkt[2]),
      totalBorrowShares: BigInt(mkt[3]),
    });
  });

  for (let i = 0; i < pairs.length; i += BATCH) {
    const slice = pairs.slice(i, i + BATCH);
    const calls = slice.map(({ market, borrower }) => ({
      target: MORPHO,
      allowFailure: true,
      callData: morphoIface.encodeFunctionData("position", [market.id, borrower]),
    }));
    const res: { success: boolean; returnData: string }[] = await withRetry((p) =>
      (mc.connect(p) as Contract).aggregate3.staticCall(calls)
    );

    res.forEach((r, j) => {
      if (!r.success) return;
      const { market, borrower } = slice[j];
      const md = marketData.get(market.id);
      if (!md || md.totalBorrowShares === 0n) return;
      const [, borrowShares, collateral] = morphoIface.decodeFunctionResult("position", r.returnData);
      const bs = BigInt(borrowShares), coll = BigInt(collateral);
      if (bs === 0n) return; // repaid — will be evicted by periodic prune

      // debt in loan-token units (round up like the protocol does)
      const debtAssets = (bs * md.totalBorrowAssets + (md.totalBorrowShares - 1n)) / md.totalBorrowShares;
      // maxBorrow = collateral * price / 1e36 * lltv
      const collValueInLoan = (coll * md.price) / ORACLE_PRICE_SCALE;
      const maxBorrow = (collValueInLoan * market.lltv) / WAD;
      if (maxBorrow === 0n) return;
      const ltvBps = Number((debtAssets * 10000n) / maxBorrow);
      results.push({ market, borrower, borrowShares: bs, collateral: coll, debtAssets, ltvBps });
    });
  }

  return results.sort((a, b) => b.ltvBps - a.ltvBps);
}

// ── Scan cycle: hot pairs every time, cold pairs round-robin ─────────────────

export async function scanCycle(coldSliceSize = 200): Promise<AtRisk[]> {
  const all: { market: Market; borrower: string }[] = [];
  for (const m of markets()) {
    for (const b of state.borrowers[m.id] ?? []) all.push({ market: m, borrower: b });
  }
  if (all.length === 0) return [];

  const hot = all.filter((p) => hotSet.has(`${p.market.id}:${p.borrower}`));
  const cold = all.filter((p) => !hotSet.has(`${p.market.id}:${p.borrower}`));
  const slice = cold.slice(normalCursor, normalCursor + coldSliceSize);
  normalCursor = normalCursor + coldSliceSize >= cold.length ? 0 : normalCursor + coldSliceSize;

  const checked = await checkHealth([...hot, ...slice]);

  // re-tier
  for (const r of checked) {
    const key = `${r.market.id}:${r.borrower}`;
    if (r.ltvBps >= HOT_LTV * 10000) hotSet.add(key);
    else hotSet.delete(key);
  }
  return checked;
}

export function hotCount(): number {
  return hotSet.size;
}

export { lifWad };
