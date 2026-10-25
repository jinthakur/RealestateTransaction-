// AI home-inspection agent for one real-estate deal.
//
// It pays for the four inspection checks (structure, roof, systems, pests), decides
// whether the home inspection passed, and records the result on-chain. It can NEVER
// move money: funds go to the seller only after a passed inspection AND buyer OK AND
// seller OK. A failed inspection lets the seller's attorney return the deposit.
//
// Modes (AGENT_MODE in .env):
//   rules   - deterministic: run every check, pass only if all pass (no AWS needed)
//   bedrock - an LLM on Amazon Bedrock drives the same tools via the Converse API
// Payments (PAYMENTS in .env): xrp (default, x402-style) or ap4m (RLUSD Channels).
//
// Usage: npm run agent -- [dealId]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import {
  BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { AUDIT_DIR, SERVICE_URL, awsClientConfig, escrowContract, fmt, provider, txLink, wallet } from "./config.js";
import { AgentWallet, PaymentRefused } from "./payments.js";
import { AP4M_ENABLED, Ap4mBuyer, rlusd } from "./ap4m.js";
import { CHECK_TYPES, type CheckType } from "./mock-checks.js";
import { announce } from "./announce.js";

const STATUS = ["None", "Deposited", "Closed", "Cancelled"];

interface CheckOutcome { ok: boolean; result: unknown; paymentTx?: string }

export class InspectionSession {
  readonly agentWallet = new AgentWallet([wallet("checkService").address]);
  readonly ap4m = new Ap4mBuyer();
  readonly escrow = escrowContract(this.agentWallet.signer);
  readonly checks: Partial<Record<CheckType, CheckOutcome>> = {};
  /** When true (deal agent), a result can only be recorded after the inspector's portal report is complete. */
  requirePortal = false;
  portal: { complete: boolean; passed?: boolean; inspector?: string; submittedAt?: string; items?: unknown } | null = null;

  async readPortal(baseUrl: string) {
    const res = await fetch(`${baseUrl}/api/inspection/${this.dealId}`);
    if (!res.ok) return { error: `portal returned ${res.status}` };
    this.portal = (await res.json()) as NonNullable<InspectionSession["portal"]>;
    return this.portal;
  }
  decision: { passed: boolean; reason: string; txHash?: string; auditHash?: string } | null = null;

  constructor(readonly dealId: bigint) {}

  async getDeal() {
    const d = await this.escrow.deals(this.dealId);
    return {
      dealId: this.dealId.toString(),
      property: d.property,
      price: fmt(d.price),
      depositInAttorneyEscrow: fmt(d.deposit),
      status: STATUS[Number(d.status)],
      inspectionAlreadyRecorded: d.inspectionDone,
      inspectionPassed: d.inspectionPassed,
      walkthroughDone: d.walkthroughDone,
      walkthroughPassed: d.walkthroughPassed,
      buyerOk: d.buyerOk,
      sellerOk: d.sellerOk,
    };
  }

  /** On-chain history of this deal plus what the escrow really holds. The agent must look at this first. */
  async getTransactions() {
    const p = provider();
    const latest = await p.getBlockNumber();
    const from = Math.max(0, latest - Number(process.env.LOG_LOOKBACK ?? 2_000));
    const events: { event: string; tx: string; block: number }[] = [];
    for (const name of ["DealOpened", "InspectionRecorded", "WalkthroughRecorded", "BuyerApproved", "SellerApproved", "DealClosed", "DealCancelled"]) {
      for (const log of await this.escrow.queryFilter(this.escrow.filters[name](this.dealId), from, latest)) {
        events.push({ event: name, tx: txLink(log.transactionHash), block: log.blockNumber });
      }
    }
    events.sort((a, b) => a.block - b.block);
    const d = await this.escrow.deals(this.dealId);
    const held = await p.getBalance(this.escrow.target as string);
    return {
      escrow: this.escrow.target,
      escrowHoldsNow: fmt(held),
      depositExpected: fmt(d.deposit),
      depositPercent: Number(d.depositBps) / 100,
      depositMatchesContractPercent: d.deposit * 10_000n === d.price * BigInt(d.depositBps) && (Number(d.depositBps) === 1000 || Number(d.depositBps) === 2000),
      depositConfirmedOnChain: events.some((e) => e.event === "DealOpened") && held >= d.deposit && d.deposit > 0n,
      events,
    };
  }

  /** Code guardrail: never spend on checks unless the 10% or 20% deposit is verifiably in escrow. */
  private async requireDeposit(): Promise<string | null> {
    const t = await this.getTransactions();
    const status = STATUS[Number((await this.escrow.deals(this.dealId)).status)];
    if (status !== "Deposited") return `deal is ${status}; no inspection needed`;
    if (!t.depositConfirmedOnChain) return "the deposit is not confirmed in escrow on-chain";
    if (!t.depositMatchesContractPercent) return "the deposit is not exactly 10% or 20% of the price";
    return null;
  }

  async runCheck(type: CheckType) {
    if (!CHECK_TYPES.includes(type)) return { error: `unknown check type ${type}` };
    const blocked = await this.requireDeposit();
    if (blocked) return { error: `not paying for checks: ${blocked}` };
    if (AP4M_ENABLED) {
      try {
        const { body, payment } = await this.ap4m.buy(type, this.dealId);
        const ok = Boolean((body as { ok?: boolean }).ok);
        this.checks[type] = { ok, result: body, paymentTx: payment.txHash };
        return { ...body, paidWith: payment.explorer, rail: "ap4m/RLUSD" };
      } catch (e) {
        return { error: `AP4M payment failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const url = `${SERVICE_URL}/checks/${type}?deal=${this.dealId}`;
    try {
      const { status, body, payment } = await this.agentWallet.payAndFetch(url);
      if (status !== 200) return { error: `check service returned ${status}`, body };
      const ok = Boolean((body as { ok?: boolean }).ok);
      this.checks[type] = { ok, result: body, paymentTx: payment?.txHash };
      return { ...(body as object), paidWith: payment?.explorer };
    } catch (e) {
      if (e instanceof PaymentRefused) return { error: `payment refused by policy: ${e.message}` };
      throw e;
    }
  }

  private writeAudit(passed: boolean, reason: string) {
    const record = {
      dealId: this.dealId.toString(),
      escrow: this.escrow.target,
      inspector: this.agentWallet.address,
      inspectionPassed: passed,
      reason,
      checks: this.checks,
      portalReport: this.portal,
      rail: AP4M_ENABLED ? "ap4m/RLUSD" : "native XRP",
      payments: AP4M_ENABLED ? this.ap4m.payments : this.agentWallet.payments,
      spent: AP4M_ENABLED ? rlusd(this.ap4m.spent) : fmt(this.agentWallet.spent),
      at: new Date().toISOString(),
    };
    const json = JSON.stringify(record, null, 2);
    const hash = ethers.keccak256(ethers.toUtf8Bytes(json));
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const file = path.join(AUDIT_DIR, `deal-${this.dealId}-${Date.now()}.json`);
    fs.writeFileSync(file, json);
    return { file, hash };
  }

  /**
   * Guardrails in code, not just in the prompt:
   *  - "passed" is refused unless all four checks ran and passed;
   *  - "failed" is refused unless at least one check actually failed;
   *  - the result can only be recorded once, on a deposited deal.
   */
  async reportInspection(passed: boolean, summary: string) {
    const missing = CHECK_TYPES.filter((t) => !this.checks[t]);
    const failed = CHECK_TYPES.filter((t) => this.checks[t] && !this.checks[t]!.ok);
    if (passed && missing.length) return { error: `cannot pass the inspection: checks not run yet: ${missing.join(", ")}` };
    if (passed && failed.length) return { error: `cannot pass the inspection: checks failed: ${failed.join(", ")}` };
    const portalFailed = this.requirePortal && this.portal?.complete && this.portal.passed === false;
    if (!passed && !failed.length && !portalFailed) return { error: "cannot fail the inspection without a failed check or a failed portal report" };
    if (this.requirePortal) {
      if (!this.portal?.complete) return { error: "the inspector has not completed the report on the portal yet (read it first)" };
      if (passed && !this.portal.passed) return { error: "cannot pass: the inspector's portal report did not pass" };
    }

    const deal = await this.getDeal();
    if (deal.status !== "Deposited") return { error: `deal is ${deal.status}, nothing to record` };
    if (deal.inspectionAlreadyRecorded) return { error: "the inspection result was already recorded" };

    const audit = this.writeAudit(passed, summary);
    const evidence = passed ? `audit:${audit.hash}` : `${failed.join(", ")} failed; audit:${audit.hash}`;
    const tx = await this.escrow.recordInspection(this.dealId, passed, evidence);
    const receipt = await tx.wait();
    this.decision = { passed, reason: summary, txHash: tx.hash, auditHash: audit.hash };
    await announce(this.escrow, receipt);
    return {
      recorded: true,
      inspectionPassed: passed,
      tx: txLink(tx.hash),
      auditFile: audit.file,
      next: passed
        ? "Inspection recorded as PASSED. The deposit moves to the seller only after the buyer AND the seller both approve."
        : "Inspection recorded as FAILED. The seller's attorney can now return the deposit to the buyer.",
    };
  }

  async dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "get_deal": return this.getDeal();
      case "get_transactions": return this.getTransactions();
      case "get_budget": return AP4M_ENABLED ? this.ap4m.budget() : this.agentWallet.budget();
      case "run_check": return this.runCheck(input.type as CheckType);
      case "report_inspection": return this.reportInspection(Boolean(input.passed), String(input.summary ?? ""));
      default: return { error: `unknown tool ${name}` };
    }
  }
}

// ---------- rules mode ----------

async function runRules(s: InspectionSession) {
  console.log("Deal:", await s.getDeal());
  console.log("Transactions:", await s.getTransactions());
  for (const t of CHECK_TYPES) {
    const r = await s.runCheck(t);
    console.log(`check ${t}:`, r);
    if ((r as { error?: string }).error) break;
  }
  const failed = CHECK_TYPES.filter((t) => !s.checks[t]?.ok);
  const out = failed.length
    ? await s.reportInspection(false, `Inspection failed: ${failed.join(", ")}`)
    : await s.reportInspection(true, "All four checks passed: structure, roof, systems, pests.");
  console.log("result:", out);
}

// ---------- bedrock mode ----------

const TOOLS: Tool[] = [
  { toolSpec: { name: "get_deal", description: "Read the deal: property, price, deposit held in the seller's attorney escrow, status.", inputSchema: { json: { type: "object", properties: {} } } } },
  { toolSpec: { name: "get_transactions", description: "Check the deal's on-chain transactions and what the attorney escrow actually holds. Use this first to confirm the deposit really arrived.", inputSchema: { json: { type: "object", properties: {} } } } },
  { toolSpec: { name: "get_budget", description: "Show the agent's spending cap, amount spent and wallet balance.", inputSchema: { json: { type: "object", properties: {} } } } },
  { toolSpec: { name: "run_check", description: "Buy one home-inspection check from the paid check service. Costs a small payment from the agent's budget.", inputSchema: { json: { type: "object", properties: { type: { type: "string", enum: [...CHECK_TYPES] } }, required: ["type"] } } } },
  { toolSpec: { name: "report_inspection", description: "Record the home-inspection result on-chain. passed=true only if every check passed. This never moves money; the buyer and seller must still both approve.", inputSchema: { json: { type: "object", properties: { passed: { type: "boolean" }, summary: { type: "string" } }, required: ["passed", "summary"] } } } },
];

const SYSTEM = `You are the AI home-inspection agent for a real-estate purchase. The buyer has deposited 10% or 20% of the price in the seller's attorney escrow account.
For the deal you are given: read the deal, then call get_transactions and confirm the deposit is really in escrow on-chain (if it is not, stop and say so; do not buy checks). Then run every check (structure, roof, systems, pests) once, then call report_inspection:
passed=true only if every check passed, otherwise passed=false with the specific problem found.
You cannot release money; the buyer and seller approve separately. Spend only what the checks cost; do not repeat a check.
End with a short plain-language summary for the buyer: what you checked, what it cost, and the result.`;

export async function runBedrock(s: InspectionSession) {
  const client = new BedrockRuntimeClient(awsClientConfig());
  const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
  const messages: Message[] = [{ role: "user", content: [{ text: `Inspect the home for deal ${s.dealId} and report the result.` }] }];

  for (let turn = 0; turn < 15; turn++) {
    const res = await client.send(new ConverseCommand({
      modelId, system: [{ text: SYSTEM }], messages, toolConfig: { tools: TOOLS },
    }));
    const msg = res.output?.message;
    if (!msg) throw new Error("empty response from Bedrock");
    messages.push(msg);

    for (const block of msg.content ?? []) if (block.text) console.log(`\nagent: ${block.text}`);
    if (res.stopReason !== "tool_use") return;

    const results: ContentBlock[] = [];
    for (const block of msg.content ?? []) {
      if (!block.toolUse) continue;
      const { toolUseId, name, input } = block.toolUse;
      console.log(`\n-> ${name}(${JSON.stringify(input ?? {})})`);
      let out: unknown;
      try {
        out = await s.dispatch(name!, (input ?? {}) as Record<string, unknown>);
      } catch (e) {
        out = { error: String(e) };
      }
      console.log("<-", JSON.stringify(out));
      results.push({ toolResult: { toolUseId, content: [{ json: out as never }] } });
    }
    messages.push({ role: "user", content: results });
  }
  console.log("Stopped after 15 turns.");
}

// ---------- main ----------

async function main() {
  const dealId = BigInt(process.argv[2] ?? 1);
  const mode = (process.env.AGENT_MODE ?? "rules").toLowerCase();
  const session = new InspectionSession(dealId);
  console.log(`Inspection agent ${session.agentWallet.address}  mode=${mode}  payments=${AP4M_ENABLED ? "ap4m" : "xrp"}`);
  console.log("Budget:", await (AP4M_ENABLED ? session.ap4m.budget() : session.agentWallet.budget()));

  if (mode === "bedrock") await runBedrock(session);
  else await runRules(session);

  if (AP4M_ENABLED) console.log(`\nSpent ${rlusd(session.ap4m.spent)} on ${session.ap4m.payments.length} paid checks (AP4M).`);
  else console.log(`\nSpent ${fmt(session.agentWallet.spent)} on ${session.agentWallet.payments.length} paid checks.`);
}

// Run only when executed directly (so tests can import InspectionSession).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
