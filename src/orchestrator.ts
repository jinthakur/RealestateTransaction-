// Deal agent: runs the whole home-purchase flow, start to finish.
//
//   1. verifies the buyer's deposit (10% or 20%) really is in the attorney escrow (on-chain)
//   2. watches the portal until the human inspector has written the report and uploaded documents,
//      and reads every message the inspector, attorney, buyer and seller posted
//   3. cross-checks with the paid inspection checks (x402 / AP4M)
//   4. records PASSED or FAILED on-chain, which unlocks the next stage
//   5. nudges the buyer for the final walkthrough, then buyer and seller for their approvals;
//      the contract closes the deal itself (or the attorney cancels after a failure)
//   6. ends with a plain-language report
//
// It never signs for the buyer, seller or attorney and never moves the deposit.
// AGENT_MODE=bedrock: an LLM on Amazon Bedrock decides each step with the tools below.
// AGENT_MODE=rules:   the same loop, deterministic (no AWS).
// Usage: npm run orchestrate -- [dealId]
import fs from "node:fs";
import {
  BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { AGENT_LOG, PORTAL_URL } from "./config.js";
import { InspectionSession } from "./agent.js";
import { CHECK_TYPES } from "./mock-checks.js";
import { type Party, msg } from "./messages.js";
import { sendEmails } from "./announce.js";

const dealId = BigInt(process.argv[2] ?? 1);
const TIMEOUT_MIN = Number(process.env.ORCH_TIMEOUT_MIN ?? 30);
const deadline = Date.now() + TIMEOUT_MIN * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const session = new InspectionSession(dealId);
session.requirePortal = true;

type LogKind = "think" | "tool" | "result" | "done" | "message";
function log(kind: LogKind, text: string, message?: { from: Party; to: Party; headline: string; text: string; tone: string }) {
  const line = { at: new Date().toISOString(), deal: dealId.toString(), kind, text: text.slice(0, 600), message };
  fs.appendFileSync(AGENT_LOG, JSON.stringify(line) + "\n");
  console.log(`[${kind}] ${text.slice(0, 300)}`);
}

const PARTIES: Party[] = ["Buyer", "Seller", "Attorney", "Inspector"];
const sent = new Set<string>();
/** Agent -> party message: logged (dashboard balloon) and emailed. Each distinct message is sent once. */
async function tell(to: Party, headline: string, text: string) {
  const key = `${to}|${headline}`;
  if (!PARTIES.includes(to) || sent.has(key) || sent.size >= 12) return { skipped: true };
  sent.add(key);
  const m = msg("Agent", to, headline, text);
  log("message", `${m.subject}: ${headline}`, m);
  await sendEmails([m]);
  return { sent: true, subject: m.subject };
}

async function tool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "read_portal": return session.readPortal(PORTAL_URL);
    case "send_message": return tell(String(input.to) as Party, String(input.headline ?? "Update"), String(input.text ?? ""));
    case "wait": {
      const s = Math.min(Math.max(Number(input.seconds ?? 10), 1), 60);
      if (Date.now() + s * 1000 > deadline) return { error: "overall time limit reached; finish with a status report" };
      await sleep(s * 1000);
      return { waited: s };
    }
    case "finish": return { finished: true };
    default: return session.dispatch(name, input);
  }
}

// ---------- rules mode ----------

async function runRules() {
  let checked = false;
  let announced = "";
  const say = (s: string) => { if (s !== announced) { announced = s; log("think", s); } };
  while (Date.now() < deadline) {
    const deal = await session.getDeal();
    if (deal.status === "Closed") return log("done", `Deal ${dealId} CLOSED: the deposit was paid to the seller after inspection, final walkthrough, buyer OK and seller OK.`);
    if (deal.status === "Cancelled") return log("done", `Deal ${dealId} CANCELLED: the deposit was returned to the buyer.`);

    const tx = await session.getTransactions();
    if (!tx.depositConfirmedOnChain) { say("Waiting for the deposit to show up in escrow."); await sleep(10_000); continue; }
    await tell("Attorney", "Deposit verified on-chain", `I checked the blockchain: the deposit of ${deal.depositInAttorneyEscrow} is in your escrow account. Next I am waiting for the inspector's report.`);

    if (!deal.inspectionAlreadyRecorded) {
      const portal = await session.readPortal(PORTAL_URL);
      if (!("complete" in portal) || !portal.complete) {
        say("Deposit confirmed. Waiting for the inspector to write the report and upload documents on the portal.");
        await tell("Inspector", "Please submit the inspection report", `The deposit is in escrow. Please write your report and upload the documents at ${PORTAL_URL}/inspector.`);
        await sleep(8_000);
        continue;
      }
      say(`Inspector report is in (${portal.passed ? "all items pass" : "has failures"}). Running the paid cross-checks.`);
      if (!checked) {
        for (const t of CHECK_TYPES) log("result", `check ${t}: ${JSON.stringify(await session.runCheck(t)).slice(0, 200)}`);
        checked = true;
      }
      const failed = CHECK_TYPES.filter((t) => !session.checks[t]?.ok);
      const passed = Boolean(portal.passed) && failed.length === 0;
      const summary = passed
        ? "Portal report passed and all four paid checks agree."
        : `Not passed: ${portal.passed ? "" : "portal report has failures; "}${failed.length ? `checks failed: ${failed.join(", ")}` : ""}`;
      log("tool", `report_inspection(passed=${passed})`);
      log("result", JSON.stringify(await session.reportInspection(passed, summary)));
      continue;
    }

    if (!deal.inspectionPassed) {
      say("Inspection FAILED and is recorded. Waiting for the attorney to cancel and return the deposit.");
      await tell("Attorney", "Please return the deposit", `The inspection failed. Please cancel the deal at ${PORTAL_URL}/attorney so the buyer gets the deposit back.`);
    } else if (!deal.walkthroughDone) {
      say("Inspection passed. Waiting for the buyer's final walkthrough.");
      await tell("Buyer", "Time for your final walkthrough", `The inspection passed. Please do the final walkthrough and record the result at ${PORTAL_URL}/buyer.`);
    } else if (!deal.walkthroughPassed) {
      say("Walkthrough found a problem. Waiting for the attorney to cancel and return the deposit.");
    } else {
      say(`Walkthrough passed. Waiting for approvals (buyer OK: ${deal.buyerOk}, seller OK: ${deal.sellerOk}).`);
      if (!deal.buyerOk) await tell("Buyer", "Please approve closing", `Everything is clear. Approve closing at ${PORTAL_URL}/buyer.`);
      if (!deal.sellerOk) await tell("Seller", "Please approve closing", `Everything is clear. Approve closing at ${PORTAL_URL}/seller to receive the deposit.`);
    }
    await sleep(8_000);
  }
  log("done", "Time limit reached before the deal closed. Current state is on the dashboard.");
}

// ---------- bedrock mode ----------

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ json: { type: "object", properties, required } as never });
const TOOLS: Tool[] = [
  { toolSpec: { name: "get_deal", description: "Read the deal from the blockchain: status, price, deposit, inspection / walkthrough / buyer OK / seller OK flags.", inputSchema: obj() } },
  { toolSpec: { name: "get_transactions", description: "List this deal's on-chain transactions and what the attorney escrow really holds. Confirms the deposit.", inputSchema: obj() } },
  { toolSpec: { name: "read_portal", description: "Read everything on the portal for this deal: the human inspector's report (complete=false until submitted), every uploaded document (name, size, sha256, text excerpt for .txt/.md), and every message written by the inspector, attorney, buyer and seller.", inputSchema: obj() } },
  { toolSpec: { name: "run_check", description: "Buy one independent inspection check (structure, roof, systems, pests) from the paid service. Costs a small payment.", inputSchema: obj({ type: { type: "string", enum: [...CHECK_TYPES] } }, ["type"]) } },
  { toolSpec: { name: "report_inspection", description: "Record the inspection result on-chain; this approves (or blocks) the next stage. Refused in code unless the portal report is complete and all four checks ran. passed=true only if the portal report AND all checks pass AND no party's message raises an unresolved problem. Never moves money.", inputSchema: obj({ passed: { type: "boolean" }, summary: { type: "string" } }, ["passed", "summary"]) } },
  { toolSpec: { name: "send_message", description: "Send a short, clear message from you (the Agent) to Buyer, Seller, Attorney or Inspector. It is emailed and shown as a balloon. Use it to ask for what is missing or to announce the next step. Each distinct headline is sent once.", inputSchema: obj({ to: { type: "string", enum: PARTIES }, headline: { type: "string" }, text: { type: "string" } }, ["to", "headline", "text"]) } },
  { toolSpec: { name: "wait", description: "Sleep up to 60 seconds (use 15-20), then check again. Use while waiting for a person.", inputSchema: obj({ seconds: { type: "number" } }, ["seconds"]) } },
  { toolSpec: { name: "finish", description: "End your run with a final plain-language report once the deal is Closed or Cancelled (or you must stop).", inputSchema: obj({ summary: { type: "string" } }, ["summary"]) } },
];

const SYSTEM = `You are the deal agent for a home purchase on a blockchain escrow. The buyer's deposit (10% or 20%) sits in the seller's attorney escrow.
The deposit goes to the seller only when: the home inspection passed AND the buyer's final walkthrough passed AND the buyer approved AND the seller approved. Then the deal closes automatically.
Real people use the portal: a human inspector writes the report and uploads documents; the attorney, buyer and seller can post messages and documents too. Read them carefully.
Work in this order and keep going until the deal is Closed or Cancelled:
1. get_deal, then get_transactions: confirm the deposit is really in escrow. If not, wait and re-check; never buy checks without it. Then tell the Attorney (send_message) that the deposit is verified.
2. read_portal repeatedly (wait between reads; send_message to the Inspector once if the report is missing) until the inspector has submitted the report. Read all messages and text documents from every role. If any party raises a problem, mention it in your decision.
3. run_check for structure, roof, systems and pests (once each) as an independent cross-check.
4. report_inspection: passed=true only if the portal report passed, every check passed and no party raised an unresolved problem; otherwise passed=false with the specific reason. This is the stage approval; it is final.
5. After a PASS, send_message to the Buyer asking for the final walkthrough; once it is done, ask Buyer and Seller to approve closing. Then wait and get_deal until Closed (both approved) or Cancelled (the attorney returns the deposit after a failure).
You cannot approve for the buyer or seller and cannot move money. Use wait with 15 to 20 seconds so you react quickly. Do not repeat a check. When the deal is Closed or Cancelled, call finish with a short plain-language report: what you verified, what you read from the people involved, what it cost, the result, and who got the money.`;

async function runBedrock() {
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
  const messages: Message[] = [{ role: "user", content: [{ text: `Run deal ${dealId} from deposit verification through to closing.` }] }];

  for (let turn = 0; turn < 150 && Date.now() < deadline; turn++) {
    const res = await client.send(new ConverseCommand({ modelId, system: [{ text: SYSTEM }], messages, toolConfig: { tools: TOOLS } }));
    const m = res.output?.message;
    if (!m) throw new Error("empty response from Bedrock");
    messages.push(m);
    for (const b of m.content ?? []) if (b.text) log("think", b.text);
    if (res.stopReason !== "tool_use") return;

    const results: ContentBlock[] = [];
    let finished = false;
    for (const b of m.content ?? []) {
      if (!b.toolUse) continue;
      const { toolUseId, name, input } = b.toolUse;
      log("tool", `${name}(${JSON.stringify(input ?? {})})`);
      let out: unknown;
      try { out = await tool(name!, (input ?? {}) as Record<string, unknown>); } catch (e) { out = { error: String(e) }; }
      if (name === "finish") { finished = true; log("done", String((input as { summary?: string })?.summary ?? "")); }
      else log("result", JSON.stringify(out));
      results.push({ toolResult: { toolUseId, content: [{ json: out as never }] } });
    }
    if (finished) return;
    messages.push({ role: "user", content: results });
  }
  log("done", "Stopped: time or turn limit reached. Current state is on the dashboard.");
}

const mode = (process.env.AGENT_MODE ?? "rules").toLowerCase();
log("think", `Deal agent started for deal ${dealId} (mode=${mode}, portal=${PORTAL_URL}).`);
if (mode === "bedrock") await runBedrock(); else await runRules();
