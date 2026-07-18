// Fruma config — HyperEVM chain 999, Morpho Blue (Felix Vanilla markets)
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const CHAIN_ID = 999;
export const CHAIN_TAG = "HYPEREVM";

export const RPC_URLS = [
  process.env.RPC_URL,
  process.env.RPC_FALLBACK_1 || "https://rpc.hyperliquid.xyz/evm",
  process.env.RPC_FALLBACK_2 || "https://hyperliquid.drpc.org",
].filter((u): u is string => !!u && !u.includes("YOUR_ALCHEMY_KEY"));

export const DRY_RUN = (process.env.DRY_RUN ?? "true") !== "false";
export const MIN_PROFIT_USD = Number(process.env.MIN_PROFIT_USD ?? "0.5");
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "8000");

// ── Morpho Blue singleton on HyperEVM (Felix "Vanilla" markets) — verified on-chain
export const MORPHO = "0x68e37de8d93d3496ae143f2e900490f6280c57cd";

// Multicall3 — same canonical address on HyperEVM as everywhere else
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Event topics (Morpho Blue) — computed from signatures, never hand-copied hashes
import { id as keccakId } from "ethers";
export const TOPIC_CREATE_MARKET = keccakId(
  "CreateMarket(bytes32,(address,address,address,address,uint256))"
);
export const TOPIC_BORROW = keccakId(
  "Borrow(bytes32,address,address,address,uint256,uint256)"
);
export const TOPIC_SUPPLY_COLLATERAL = keccakId(
  "SupplyCollateral(bytes32,address,address,uint256)"
);
export const TOPIC_LIQUIDATE = keccakId(
  "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"
);

export const MORPHO_ABI = [
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function liquidate((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) returns (uint256, uint256)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
];

export const ORACLE_ABI = [
  "function price() view returns (uint256)", // Morpho oracle: scaled 1e36 * loanDecimals/collateralDecimals
];

export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

export const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];

// Morpho constants
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const WAD = 10n ** 18n;

// Liquidation Incentive Factor: min(1.15, 1/(0.3*lltv + 0.7))
export function lifWad(lltv: bigint): bigint {
  const denom = (3n * lltv) / 10n + (7n * WAD) / 10n;
  const lif = (WAD * WAD) / denom;
  const cap = (115n * WAD) / 100n;
  return lif < cap ? lif : cap;
}
