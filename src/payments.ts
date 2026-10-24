// The agent's wallet + spending guardrails.
//
// Three layers keep the agent inside its mandate:
//   1. On-chain: the agent wallet only ever holds its budget (topped up by setup).
//   2. Policy: per-call max, session max, and an allowlist of payees, checked
//      BEFORE any money moves.
//   3. Audit: every payment is recorded with its tx hash for the evidence trail.
import { ethers } from "ethers";
import { AGENT_BUDGET, AGENT_MAX_PER_CALL, CHAIN_ID, fmt, provider, txLink, txSigner, wallet } from "./config.js";

export interface PaymentRecord {
  resource: string;
  payTo: string;
  amountWei: string;
  txHash: string;
  explorer: string;
  at: string;
}

interface Requirement {
  scheme: string;
  chainId: number;
  asset: string;
  payTo: string;
  amount: string;
  nonce: string;
  resource: string;
}

export class PaymentRefused extends Error {}

export class AgentWallet {
  readonly address = wallet("inspector").address;
  readonly signer = txSigner("inspector");
  readonly sessionCap = ethers.parseEther(AGENT_BUDGET);
  readonly perCallCap = ethers.parseEther(AGENT_MAX_PER_CALL);
  readonly allowedPayees: Set<string>;
  spent = 0n;
  payments: PaymentRecord[] = [];

  constructor(allowedPayees: string[]) {
    this.allowedPayees = new Set(allowedPayees.map((a) => a.toLowerCase()));
  }

  async budget() {
    const onChain = await provider().getBalance(this.address);
    return {
      address: this.address,
      sessionCap: fmt(this.sessionCap),
      spentThisSession: fmt(this.spent),
      remainingThisSession: fmt(this.sessionCap - this.spent),
      walletBalance: fmt(onChain),
    };
  }

  private check(req: Requirement) {
    const amount = BigInt(req.amount);
    if (req.scheme !== "exact" || req.asset !== "XRP") throw new PaymentRefused(`unsupported payment scheme ${req.scheme}/${req.asset}`);
    if (Number(req.chainId) !== CHAIN_ID) throw new PaymentRefused(`asked to pay on chain ${req.chainId}, agent is on ${CHAIN_ID}`);
    if (!this.allowedPayees.has(req.payTo.toLowerCase())) throw new PaymentRefused(`payee ${req.payTo} is not on the allowlist`);
    if (amount > this.perCallCap) throw new PaymentRefused(`price ${fmt(amount)} exceeds per-call limit ${fmt(this.perCallCap)}`);
    if (this.spent + amount > this.sessionCap) throw new PaymentRefused(`price ${fmt(amount)} would exceed session budget (${fmt(this.sessionCap - this.spent)} left)`);
  }

  /** GET a URL; if it answers 402, pay within policy and retry once with proof. */
  async payAndFetch(url: string): Promise<{ status: number; body: unknown; payment?: PaymentRecord }> {
    const first = await fetch(url);
    if (first.status !== 402) return { status: first.status, body: await first.json() };

    const quote = (await first.json()) as { accepts?: Requirement[] };
    const req = quote.accepts?.[0];
    if (!req) throw new PaymentRefused("402 without payment requirements");
    this.check(req);

    let tx: ethers.TransactionResponse;
    try {
      tx = await this.signer.sendTransaction({
        to: req.payTo,
        value: BigInt(req.amount),
        data: ethers.hexlify(ethers.toUtf8Bytes(req.nonce)),
      });
    } catch (e) {
      this.signer.reset(); // the send never landed; resync the local nonce
      throw e;
    }
    await tx.wait();
    this.spent += BigInt(req.amount);

    const record: PaymentRecord = {
      resource: req.resource,
      payTo: req.payTo,
      amountWei: req.amount,
      txHash: tx.hash,
      explorer: txLink(tx.hash),
      at: new Date().toISOString(),
    };
    this.payments.push(record);

    const proof = Buffer.from(JSON.stringify({ txHash: tx.hash, nonce: req.nonce })).toString("base64");
    const second = await fetch(url, { headers: { "X-PAYMENT": proof } });
    return { status: second.status, body: await second.json(), payment: record };
  }
}
