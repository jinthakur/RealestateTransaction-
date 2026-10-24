// Human steps in the deal.  Usage: npm run deal -- <action> [dealId] ["note"]
//   walkthrough-ok     buyer: final walkthrough passed
//   walkthrough-issue  buyer: final walkthrough found a problem
//   buyer-ok           buyer approves closing
//   seller-ok          seller approves closing
//   cancel             seller's attorney returns the deposit to the buyer
//   refund             buyer reclaims the deposit after the deadline
import { escrowContract, fmt, provider, txLink, txSigner, wallet } from "../src/config.js";
import { announce } from "../src/announce.js";

const action = process.argv[2];
const dealId = BigInt(process.argv[3] ?? 1);
const note = process.argv[4] ?? "";

const who = { "walkthrough-ok": "buyer", "walkthrough-issue": "buyer", "buyer-ok": "buyer", "seller-ok": "seller", cancel: "attorney", refund: "buyer" } as const;
const role = who[action as keyof typeof who];
if (!role) throw new Error(`action must be one of: ${Object.keys(who).join(" | ")}`);

const escrow = escrowContract(txSigner(role));
const tx = action === "walkthrough-ok" ? await escrow.recordWalkthrough(dealId, true, note || "satisfied with the home")
  : action === "walkthrough-issue" ? await escrow.recordWalkthrough(dealId, false, note || "problem found")
  : action === "buyer-ok" ? await escrow.buyerApprove(dealId)
  : action === "seller-ok" ? await escrow.sellerApprove(dealId)
  : action === "cancel" ? await escrow.cancel(dealId, note || "inspection failed")
  : await escrow.refundAfterDeadline(dealId);
console.log(`${role} ${action} on deal ${dealId} ... ${txLink(tx.hash)}`);
await announce(escrow, await tx.wait());

const d = await escrow.deals(dealId);
console.log(`\nStatus: ${["None", "Deposited", "Closed", "Cancelled"][Number(d.status)]}`);
console.log(`Seller balance: ${fmt(await provider().getBalance(wallet("seller").address))}`);
