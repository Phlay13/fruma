// Fruma engine — Phase 1: shadow monitor. Read-only, no key, no capital.
// Discovers Morpho markets + borrowers on HyperEVM, tracks health, and shadow-logs
// every liquidation with whether WE had the borrower hotlisted at the time.
// That log answers "what would our win-rate be?" before we spend a cent.
import { CHAIN_TAG, MORPHO, POLL_INTERVAL_MS, DRY_RUN } from "./config";
import { rpcSummary, withRetry } from "./rpc";
import { bootstrap, pollNewEvents, scanCycle, markets, borrowerCount, hotCount } from "./monitor";
import { log, warn, shadow } from "./utils/logger";

// Morpho singleton deploy on HyperEVM is early-2025; bounded lookback keeps
// bootstrap cheap on free RPC tiers. Positions opened earlier still get found
// as soon as they emit any new Borrow event; deep history can be backfilled later.
const LOOKBACK_BLOCKS = 900_000; // ~10 days of HyperEVM blocks (~1s small blocks)

// CI mode (GitHub Actions): run a bounded scan window then exit cleanly so the
// workflow can commit state back. Unset = run forever (JustRunMy / local).
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS ?? "0");

async function main(): Promise<void> {
  log(`Fruma starting — ${CHAIN_TAG}, Morpho ${MORPHO}`);
  log(`mode: SHADOW MONITOR (read-only, DRY_RUN=${DRY_RUN}) — ${rpcSummary()}`);

  const head = await withRetry((p) => p.getBlockNumber());
  const ciDeadline = MAX_RUNTIME_MS > 0 ? Date.now() + Math.floor(MAX_RUNTIME_MS * 0.8) : 0;
  await bootstrap(Math.max(1, head - LOOKBACK_BLOCKS), ciDeadline);

  let cycle = 0;
  const startedAt = Date.now();
  for (;;) {
    const started = Date.now();
    try {
      await pollNewEvents();
      const atRisk = await scanCycle();

      const liquidatable = atRisk.filter((r) => r.ltvBps >= 10000);
      for (const r of liquidatable) {
        // We WOULD liquidate here in Phase 3. For now: record the sighting.
        shadow({
          type: "liquidatable_seen",
          marketId: r.market.id,
          borrower: r.borrower,
          ltvBps: r.ltvBps,
          debtAssets: r.debtAssets.toString(),
          collateral: r.collateral.toString(),
          pair: `${r.market.collSymbol}/${r.market.loanSymbol}`,
        });
        log(`⚡ LIQUIDATABLE ${r.market.collSymbol}/${r.market.loanSymbol} borrower ${r.borrower.slice(0, 10)}… ltv=${(r.ltvBps / 100).toFixed(2)}% of LLTV`);
      }

      if (cycle % 20 === 0) {
        const worst = atRisk[0];
        log(
          `cycle ${cycle}: ${markets().length} markets, ${borrowerCount()} borrowers, ` +
          `${hotCount()} hot, worst ltv=${worst ? (worst.ltvBps / 100).toFixed(1) + "%" : "n/a"}`
        );
      }
      cycle++;
    } catch (err) {
      warn(`cycle error: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
    const elapsed = Date.now() - started;
    if (MAX_RUNTIME_MS > 0 && Date.now() - startedAt > MAX_RUNTIME_MS) {
      log(`CI window done (${cycle} cycles) — exiting for state commit`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, Math.max(500, POLL_INTERVAL_MS - elapsed)));
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
