import "dotenv/config";
import { closeDb } from "../../lib/database/client";
import { verifyAllPools } from "../../lib/onchain/verify-pool";
import { verifyAllProtocolTvls } from "../../lib/onchain/verify-protocol-tvl";

export async function verifyOnchain() {
  const results = [...(await verifyAllPools()), ...(await verifyAllProtocolTvls())];
  for (const r of results) {
    if (r.ok) {
      console.log(`[onchain] verified ${r.key}`);
    } else {
      console.warn(`[onchain] ${r.key} skipped: ${r.error}`);
    }
  }
}

if (require.main === module) {
  verifyOnchain()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("[onchain] verify failed:", err);
      await closeDb();
      process.exitCode = 1;
    });
}
