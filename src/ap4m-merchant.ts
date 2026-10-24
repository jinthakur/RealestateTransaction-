// AP4M x402 merchant for the four home-inspection checks (RLUSD, voucher-redeemed on-chain).
// Usage: npm run ap4m:merchant   (SCENARIO=fail makes the roof check fail)
import { PROPERTY } from "./config.js";
import { startMerchants } from "./ap4m.js";
import { mockResult } from "./mock-checks.js";

const fail = (process.env.SCENARIO ?? "pass").toLowerCase() === "fail";

console.log("AP4M inspection-check merchants:");
const close = await startMerchants((type) => ({ check: type, ...mockResult(type, PROPERTY, fail) }));
process.on("SIGINT", async () => { await close(); process.exit(0); });
