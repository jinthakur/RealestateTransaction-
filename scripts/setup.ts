// Shows every role's address and balance, then tops up the agent (its spending
// budget) and the inspector (gas) from the contractor wallet. Safe to re-run:
// it only sends the difference up to each target.
import { ethers } from "ethers";
import { AGENT_BUDGET, GAS_TOPUP, ROLE_INDEX, Role, fmt, provider, txLink, txSigner, wallet } from "../src/config.js";

const p = provider();
const buyer = txSigner("buyer");

console.log("Roles derived from your mnemonic:\n");
for (const role of Object.keys(ROLE_INDEX) as Role[]) {
  const w = wallet(role);
  console.log(`  ${role.padEnd(14)} ${w.address}  ${fmt(await p.getBalance(w.address))}`);
}

// The agent gets its spending budget PLUS gas money, so it can always use its full budget.
const agentTarget = ethers.formatEther(ethers.parseEther(AGENT_BUDGET) + ethers.parseEther(GAS_TOPUP));
const targets: [Role, string][] = [
  ["inspector", agentTarget],
  ["attorney", GAS_TOPUP],
  ["seller", GAS_TOPUP],
  ["checkService", GAS_TOPUP],
];

console.log("");
for (const [role, amount] of targets) {
  const to = wallet(role).address;
  const want = ethers.parseEther(amount);
  const have = await p.getBalance(to);
  if (have >= want) {
    console.log(`${role}: already has ${fmt(have)} (target ${amount} XRP)`);
    continue;
  }
  const tx = await buyer.sendTransaction({ to, value: want - have });
  console.log(`${role}: sending ${fmt(want - have)} ... ${txLink(tx.hash)}`);
  await tx.wait();
}
console.log(`\nBuyer balance now ${fmt(await p.getBalance(await buyer.getAddress()))}`);
