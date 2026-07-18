// Fruma logger — plain, timestamped, with a JSONL shadow-log for missed/observed liquidations
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[${ts()}] WARN ${msg}`);
}

// Shadow log: every liquidation opportunity we saw (and who actually won it).
// This is Phase 1's whole product — it measures our realistic win-rate for free.
const SHADOW_FILE = path.join(DATA_DIR, "shadow-log.jsonl");
export function shadow(entry: Record<string, unknown>): void {
  fs.appendFileSync(
    SHADOW_FILE,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"
  );
}
