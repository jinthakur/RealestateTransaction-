// Prints a deal's state and on-chain history.  Usage: npm run status -- [dealId]
import { escrowContract, fmt, provider, txLink, wallet } from "../src/config.js";

const dealId = BigInt(process.argv[2] ?? 1);
const p = provider();
const escrow = escrowContract(p);
const d = await escrow.deals(dealId);
console.log(`Escrow ${escrow.target}`);
console.log(`Deal ${dealId}: ${d.property}`);
console.log(`  price ${fmt(d.price)}, deposit held ${fmt(d.deposit)}, status ${["None", "Deposited", "Closed", "Cancelled"][Number(d.status)]}`);
console.log(`  inspection ${d.inspectionDone ? (d.inspectionPassed ? "PASSED" : "FAILED") : "pending"}, walkthrough ${d.walkthroughDone ? (d.walkthroughPassed ? "PASSED" : "PROBLEM") : "pending"}, buyer ${d.buyerOk ? "OK" : "-"}, seller ${d.sellerOk ? "OK" : "-"}\n`);

const latest = await p.getBlockNumber();
const fromBlock = Math.max(0, latest - Number(process.env.LOG_LOOKBACK ?? 10_000));
for (const name of ["DealOpened", "InspectionRecorded", "WalkthroughRecorded", "BuyerApproved", "SellerApproved", "DealClosed", "DealCancelled"]) {
  for (const log of await escrow.queryFilter(escrow.filters[name](dealId), fromBlock, latest)) {
    console.log(`  ${name.padEnd(19)} ${txLink(log.transactionHash)}`);
  }
}
console.log(`\nSeller balance: ${fmt(await p.getBalance(wallet("seller").address))}`);
