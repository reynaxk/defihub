import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { withResilientClient } from "../../lib/chains/rpc-resilient-client";
import { scanFromCursor } from "../../lib/indexing/events";
import { logger } from "../../lib/observability/logger";

// Foundation example only - proves lib/indexing/events.ts's chunked-scan
// and cursor-persistence primitives work end-to-end against a real chain.
// NOT wired to any cron schedule and NOT a shipped product feature: run
// by hand (`npx tsx workers/onchain/scan-events-example.ts`), scans a
// small, bounded recent window of Swap events on the existing verified
// Uniswap V3 USDC/WETH 0.05% pool (lib/onchain/config.ts's
// VERIFIED_POOLS), and logs a count plus one decoded sample. No dedicated
// events table, no API surface - deliberately not expanding this beyond
// proving the primitives work, per the task's explicit scope.

const CHAIN_SLUG = "ethereum";
const COMPONENT = "example-uniswap-v3-usdc-weth-swaps";
// Same address as VERIFIED_POOLS' "uniswap-v3-eth-usdc-weth-005" entry
// (lib/onchain/config.ts) - reusing an already-verified pool rather than
// researching a new one for a foundation example.
const POOL_ADDRESS = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const SWAP_EVENT =
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
// A small, bounded window - this is a proof the primitives work, not a
// real backfill.
const SCAN_WINDOW_BLOCKS = BigInt(1000);

async function main() {
  const currentBlock = await withResilientClient(CHAIN_SLUG, (client) => client.getBlockNumber());
  const startBlock = currentBlock > SCAN_WINDOW_BLOCKS ? currentBlock - SCAN_WINDOW_BLOCKS : BigInt(0);

  const result = await scanFromCursor({
    chainSlug: CHAIN_SLUG,
    component: COMPONENT,
    address: POOL_ADDRESS,
    eventSignature: SWAP_EVENT,
    currentBlock,
    startBlock,
    onLogs: async (logs) => {
      logger.info("scanned swap events", {
        component: "onchain-events-example",
        recordsProcessed: logs.length,
      });
      const sample = logs[0];
      if (sample) {
        logger.info("sample decoded event", {
          component: "onchain-events-example",
          blockNumber: sample.blockNumber?.toString(),
          transactionHash: sample.transactionHash,
          logIndex: sample.logIndex,
        });
      }
    },
  });

  logger.info("scan complete", {
    component: "onchain-events-example",
    scannedFrom: result.scannedFrom.toString(),
    scannedTo: result.scannedTo.toString(),
    logCount: result.logCount,
  });
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    logger.error("scan failed", { component: "onchain-events-example", error: err });
    await closeDb();
    process.exitCode = 1;
  });
