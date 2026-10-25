// After a transaction, turn its on-chain events into clear messages: print them and email them.
// All emails go to ONE mailbox (NOTIFY_TO); the subject says who the message is for:
// "Seller message", "Buyer message" or "Attorney message".
import { ethers } from "ethers";
import nodemailer from "nodemailer";
import { PROPERTY } from "./config.js";
import { type DealEvent, type PartyMessage, messagesFor } from "./messages.js";

const xrp = (wei: bigint) => `${ethers.formatEther(wei)} XRP`;

/** Convert a parsed contract log into a DealEvent. `deal` is the deal state AFTER the tx. */
export function toDealEvent(name: string, args: ethers.Result, deal?: ethers.Result): DealEvent | null {
  const dealId = args[0].toString();
  switch (name) {
    case "DealOpened": return { name, dealId, price: xrp(args.price), deposit: xrp(args.deposit), depositPct: Number(args.depositBps) / 100, property: args.property || PROPERTY };
    case "InspectionRecorded": return { name, dealId, passed: args.passed, evidence: args.evidence, deposit: deal ? xrp(deal.deposit) : undefined, property: deal?.property };
    case "WalkthroughRecorded": return { name, dealId, passed: args.passed, evidence: args.notes, deposit: deal ? xrp(deal.deposit) : undefined, property: deal?.property };
    case "BuyerApproved": return { name, dealId, otherOk: deal?.sellerOk, property: deal?.property };
    case "SellerApproved": return { name, dealId, otherOk: deal?.buyerOk, property: deal?.property };
    case "DealClosed": return { name, dealId, amount: xrp(args.amount), property: deal?.property };
    case "DealCancelled": return { name, dealId, amount: xrp(args.amount), reason: args.reason, property: deal?.property };
    default: return null;
  }
}

function transport() {
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "mail.askyourquestions.info",
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Certificate check disabled on request (the mail host's cert does not match its name).
    tls: { rejectUnauthorized: false },
  });
}

export async function sendEmails(messages: PartyMessage[]) {
  const t = transport();
  if (!t) {
    console.log("  (email skipped: set SMTP_USER and SMTP_PASS in .env)");
    return;
  }
  const to = process.env.NOTIFY_TO ?? process.env.SMTP_USER!;
  for (const m of messages) {
    try {
      await t.sendMail({
        from: process.env.SMTP_USER,
        to,
        subject: m.subject,
        text: `From: ${m.from}\nTo: ${m.to}\n\n${m.headline}\n\n${m.text}\n\n(SiteEscrow demo - XRPL EVM Testnet)`,
      });
      console.log(`  emailed "${m.subject}" to ${to}`);
    } catch (e) {
      console.log(`  email failed for "${m.subject}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Print and email the messages for every escrow event in a mined transaction. */
export async function announce(escrow: ethers.Contract, receipt: ethers.TransactionReceipt | null) {
  if (!receipt) return;
  const out: PartyMessage[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== String(escrow.target).toLowerCase()) continue;
    const parsed = escrow.interface.parseLog(log);
    if (!parsed) continue;
    const deal = await escrow.deals(parsed.args[0]);
    const ev = toDealEvent(parsed.name, parsed.args, deal);
    if (ev) out.push(...messagesFor(ev));
  }
  for (const m of out) console.log(`\n[${m.from} -> ${m.to}] ${m.headline}\n  ${m.text}`);
  if (out.length) await sendEmails(out);
}
