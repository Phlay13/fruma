// Fruma RPC — provider rotation with automatic failover (HyperEVM rate limits are real)
import { JsonRpcProvider } from "ethers";
import { RPC_URLS, CHAIN_ID } from "./config";
import { warn, log } from "./utils/logger";

const providers: JsonRpcProvider[] = RPC_URLS.map(
  (url) => new JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true })
);

if (providers.length === 0) {
  throw new Error("No RPC URLs configured. Copy .env.example to .env and set RPC_URL.");
}

// Alchemy free tier caps eth_getLogs at 10 blocks/request — so logs traffic goes
// to the official/dRPC endpoints (wide ranges allowed), while state calls
// (multicall health checks) go to Alchemy (its strength, 30M CU/mo).
const logsProviders = providers.filter((p) => !String(p._getConnection().url).includes("alchemy"));
const logsPool = logsProviders.length > 0 ? logsProviders : providers;

let active = 0;
let failStreak = 0;
let logsActive = 0;
let logsFailStreak = 0;
let lastLogsCall = 0;
const LOGS_MIN_GAP_MS = 700; // stay under official RPC's 100 req/min

export function provider(): JsonRpcProvider {
  return providers[active];
}

export function reportRpcFailure(err: unknown): void {
  failStreak++;
  const msg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
  if (failStreak >= 3 && providers.length > 1) {
    active = (active + 1) % providers.length;
    failStreak = 0;
    warn(`RPC failing (${msg}) — rotated to provider #${active + 1}/${providers.length}`);
  }
}

export function reportRpcSuccess(): void {
  failStreak = 0;
}

// Simple retry wrapper: tries current provider, rotates on repeated failure.
export async function withRetry<T>(fn: (p: JsonRpcProvider) => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fn(provider());
      reportRpcSuccess();
      return res;
    } catch (err) {
      lastErr = err;
      reportRpcFailure(err);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export function rpcSummary(): string {
  return `${providers.length} RPC endpoint(s), active #${active + 1}, logs via ${logsPool.length} endpoint(s)`;
}

// Dedicated path for eth_getLogs: throttled, rotates within the non-Alchemy pool.
export async function withLogsRetry<T>(fn: (p: JsonRpcProvider) => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    const wait = lastLogsCall + LOGS_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastLogsCall = Date.now();
    try {
      const res = await fn(logsPool[logsActive]);
      logsFailStreak = 0;
      return res;
    } catch (err) {
      lastErr = err;
      logsFailStreak++;
      if (logsFailStreak >= 2 && logsPool.length > 1) {
        logsActive = (logsActive + 1) % logsPool.length;
        logsFailStreak = 0;
        warn(`logs RPC rotated to #${logsActive + 1}/${logsPool.length}`);
      }
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

export { log };
