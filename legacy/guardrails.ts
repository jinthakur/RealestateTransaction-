// Guardrail tests: payment proofs, spending policy, agent rules, and the contract.
// Run against a LOCAL chain (see README "Test locally"), with the check service
// running in SCENARIO=fail mode and phase 2 funded:
//   npm run deploy -- 2 "Phase 2: steel frame"
//   npm run test:guardrails
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { CHAIN_ID, SERVICE_URL, escrowContract, txSigner, wallet } from "../src/config.js";
import { AgentWallet, PaymentRefused } from "../src/payments.js";
import { InspectionSession } from "../src/agent.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
async function rejects(p: Promise<unknown>, match: RegExp) {
  await assert.rejects(p, (e: unknown) => match.test(String((e as Error)?.message ?? e)));
}

const agent = txSigner("agent");
const service = wallet("checkService").address;
const proof = (txHash: string, nonce: string) =>
  Buffer.from(JSON.stringify({ txHash, nonce })).toString("base64");

async function quote(type = "license") {
  const r = await fetch(`${SERVICE_URL}/checks/${type}`);
  assert.equal(r.status, 402);
  return ((await r.json()) as { accepts: { amount: string; nonce: string; payTo: string }[] }).accepts[0];
}
async function pay(to: string, value: bigint, nonce: string) {
  const tx = await agent.sendTransaction({ to, value, data: ethers.hexlify(ethers.toUtf8Bytes(nonce)) });
  await tx.wait();
  return tx.hash;
}
async function redeem(type: string, header: string) {
  const r = await fetch(`${SERVICE_URL}/checks/${type}`, { headers: { "X-PAYMENT": header } });
  return { status: r.status, body: (await r.json()) as { reason?: string } };
}

console.log("Check service payment proofs");
await test("a valid payment unlocks the check once; a replay is rejected", async () => {
  const q = await quote();
  const hash = await pay(q.payTo, BigInt(q.amount), q.nonce);
  assert.equal((await redeem("license", proof(hash, q.nonce))).status, 200);
  const again = await redeem("license", proof(hash, q.nonce));
  assert.equal(again.status, 402);
});
await test("a payment cannot be reused for a different nonce", async () => {
  const q1 = await quote();
  const hash = await pay(q1.payTo, BigInt(q1.amount), q1.nonce);
  const q2 = await quote();
  const r = await redeem("license", proof(hash, q2.nonce));
  assert.equal(r.status, 402);
  assert.match(r.body.reason!, /not bound to this nonce/);
});
await test("underpaying is rejected", async () => {
  const q = await quote();
  const hash = await pay(q.payTo, BigInt(q.amount) - 1n, q.nonce);
  assert.match((await redeem("license", proof(hash, q.nonce))).body.reason!, /underpaid/);
});
await test("paying someone else is rejected", async () => {
  const q = await quote();
  const hash = await pay(wallet("subcontractor").address, BigInt(q.amount), q.nonce);
  assert.match((await redeem("license", proof(hash, q.nonce))).body.reason!, /wrong address/);
});
await test("a nonce issued for one check cannot unlock another", async () => {
  const q = await quote("license");
  const hash = await pay(q.payTo, BigInt(q.amount), q.nonce);
  assert.match((await redeem("photos", proof(hash, q.nonce))).body.reason!, /different check/);
});

console.log("Agent spending policy (no money moves when refused)");
const req = (over: Partial<Record<string, unknown>>) => ({
  scheme: "exact", chainId: CHAIN_ID, asset: "XRP", payTo: service,
  amount: ethers.parseEther("0.01").toString(), nonce: "n", resource: "/x", ...over,
});
// check() is private; reach it for unit testing only.
const policy = (w: AgentWallet, r: object) => (w as unknown as { check(r: object): void }).check(r);
await test("refuses a payee that is not on the allowlist", async () => {
  assert.throws(() => policy(new AgentWallet([service]), req({ payTo: wallet("subcontractor").address })), PaymentRefused);
});
await test("refuses a price above the per-call limit", async () => {
  assert.throws(() => policy(new AgentWallet([service]), req({ amount: ethers.parseEther("0.5").toString() })), /per-call limit/);
});
await test("refuses once the session budget would be exceeded", async () => {
  const w = new AgentWallet([service]);
  w.spent = w.sessionCap - 1n;
  assert.throws(() => policy(w, req({})), /session budget/);
});
await test("refuses a different chain", async () => {
  assert.throws(() => policy(new AgentWallet([service]), req({ chainId: 1 })), /chain/);
});

console.log("Agent decision rules");
await test("will not approve before every check has run", async () => {
  const s = new InspectionSession(2n);
  const r = (await s.approveRelease("trust me")) as { error?: string };
  assert.match(r.error!, /checks not run yet/);
});
await test("will not approve when a check failed (service in fail mode)", async () => {
  const s = new InspectionSession(2n);
  for (const t of ["license", "insurance", "permit", "photos"] as const) await s.runCheck(t);
  const r = (await s.approveRelease("looks fine")) as { error?: string };
  assert.match(r.error!, /checks failed: photos/);
  const ph = await escrowContract(txSigner("agent")).phases(2n);
  assert.equal(Number(ph.approvals), 0);
});

console.log("Escrow contract");
await test("a non-approver cannot approve", async () => {
  await rejects(escrowContract(txSigner("subcontractor")).approve(2n, "x"), /revert|NotApprover|insufficient funds/i);
});
await test("an approver cannot approve twice", async () => {
  const c = escrowContract(txSigner("inspector"));
  await (await c.approve(2n, "first")).wait();
  await rejects(c.approve(2n, "second"), /revert|AlreadyApproved/i);
});
await test("one approval alone does not release funds", async () => {
  const ph = await escrowContract(txSigner("inspector")).phases(2n);
  assert.equal(Number(ph.status), 1); // still Funded
  assert.equal(Number(ph.approvals), 1);
});
await test("the contractor cannot refund before the deadline", async () => {
  await rejects(escrowContract(txSigner("contractor")).refund(2n), /revert|TooEarly/i);
});

console.log(`\n${passed} passed`);
