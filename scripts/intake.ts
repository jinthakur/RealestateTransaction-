// Contract intake: the agent reads the purchase contract the seller's attorney uploaded on the attorney page,
// extracts the contract date and the 10% or 20% deposit, and only then opens the escrow.
// If the contract cannot be read (PDF/image, missing or conflicting facts), nothing is executed:
// the agent emails the buyer and attorney and waits for a new upload.
// Usage: npm run deploy (with INTAKE=1) then npm run intake -- [dealId]
import fs from "node:fs";
import { ethers } from "ethers";
import { AGENT_LOG, PORTAL_URL, PRICE, PROPERTY, escrowContract, fmt, txLink, txSigner } from "../src/config.js";
import { announce, sendEmails } from "../src/announce.js";
import { readContract } from "../src/contract.js";
import { msg } from "../src/messages.js";

const dealId = BigInt(process.argv[2] ?? 1);
const TIMEOUT_MIN = Number(process.env.ORCH_TIMEOUT_MIN ?? 30);
const deadline = Date.now() + TIMEOUT_MIN * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PortalDoc { by: string; name: string; sha256: string; uploadedAt: string; excerpt?: string }
const CONTRACT_NAME = /contract|agreement|purchase/i;

function log(kind: "think" | "result" | "message", text: string, message?: unknown) {
  fs.appendFileSync(AGENT_LOG, JSON.stringify({ at: new Date().toISOString(), deal: dealId.toString(), kind, text: text.slice(0, 600), message }) + "\n");
  console.log(`[${kind}] ${text.slice(0, 300)}`);
}

const escrow = escrowContract(txSigner("buyer"));
if (Number((await escrow.deals(dealId)).status) !== 0) {
  console.log(`Deal ${dealId} is already open; nothing to do.`);
  process.exit(0);
}

const handled = new Set<string>();
let announcedWaiting = false;
while (Date.now() < deadline) {
  const portal = await (await fetch(`${PORTAL_URL}/api/inspection/${dealId}`)).json() as { documents: PortalDoc[] };
  const contract = portal.documents
    .filter((d) => d.by === "attorney" && CONTRACT_NAME.test(d.name) && !handled.has(d.sha256))
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
  if (!contract) {
    if (!announcedWaiting) { log("think", `Waiting for the seller's attorney to upload the purchase contract at ${PORTAL_URL}/attorney (file name must contain "contract").`); announcedWaiting = true; }
    await sleep(8_000);
    continue;
  }
  handled.add(contract.sha256);
  log("think", `Reading ${contract.name}`);

  const reading = contract.excerpt
    ? await readContract(contract.excerpt)
    : { ok: false as const, reason: `${contract.name} is a PDF or image, and I can only read text contracts (.txt or .md) for now` };

  if (!reading.ok) {
    const m = [
      msg("Agent", "Attorney", "I could not read the contract",
        `I could not read ${contract.name}: ${reading.reason}. The escrow has not been opened and no money has moved. Please upload a text version (.txt or .md) of the contract at ${PORTAL_URL}/attorney, with a line like "Contract Date: 2026-10-20" and the deposit clause (10% or 20%).`, "bad"),
      msg("Agent", "Buyer", "Contract could not be read - deposit not taken",
        `The contract ${contract.name} uploaded by the seller's attorney could not be read automatically (${reading.reason}). Nothing has been signed and your deposit has not moved. I am waiting for a readable contract.`, "bad"),
    ];
    log("message", `Contract unreadable: ${reading.reason}`, m[0]);
    await sendEmails(m);
    announcedWaiting = false;
    continue;
  }

  const price = ethers.parseEther(PRICE);
  const bps = reading.depositPct * 100;
  const deposit = (price * BigInt(bps)) / 10_000n;
  const property = `${PROPERTY} (contract dated ${reading.date})`;
  log("result", `Contract read (${reading.source}): dated ${reading.date}, ${reading.depositPct}% deposit. Opening the escrow.`);
  const dl = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  const tx = await escrow.openDeal(dealId, price, bps, dl, property, { value: deposit });
  console.log(`Buyer signs and deposits ${reading.depositPct}% (${fmt(deposit)} of ${fmt(price)}) ... ${txLink(tx.hash)}`);
  await announce(escrow, await tx.wait());
  process.exit(0);
}
log("think", "Timed out waiting for a readable contract.");
process.exit(1);
