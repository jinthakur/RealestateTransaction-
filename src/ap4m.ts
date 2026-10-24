// AP4M (Mastercard hackathon) payment rail: RLUSD payment Channels + x402 vouchers.
// Enabled with PAYMENTS=ap4m. Docs: <AP4M_API_URL>/llms.txt (needs hackathon login).
import { ethers } from "ethers";
import sdk from "../ap4m-hackathon-sdk.cjs";
import { buyResource, createX402Merchant, loadX402Context } from "../ap4m-x402.mjs";
import { AGENT_BUDGET, AGENT_MAX_PER_CALL, CHECK_PRICE, RPC_URL, type Role, loadDeployment, provider, wallet } from "./config.js";
import { CHECK_TYPES, type CheckType } from "./mock-checks.js";
export { CHECK_TYPES, type CheckType };

export const AP4M_API_URL = process.env.AP4M_API_URL ?? "https://hackathon.ap4m.build";
export const AP4M_ENABLED = (process.env.PAYMENTS ?? "").toLowerCase() === "ap4m";
const STATE_DIR = process.env.AP4M_STATE_DIR ?? ".ap4m-state";
export const MERCHANT_BASE_PORT = Number(process.env.AP4M_MERCHANT_PORT ?? 4021);



const toWei = (v: string) => ethers.parseUnits(v, 18); // RLUSD has 18 decimals
export const rlusd = (wei: bigint) => `${ethers.formatUnits(wei, 18)} RLUSD`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example, AP4M section)`);
  return v;
}

/** The wallet onboarded on the AP4M "My setup" page. Falls back to the demo agent wallet. */
export function ap4mAgentWallet(): ethers.Wallet {
  const key = process.env.AGENT_PRIVATE_KEY;
  const role = (process.env.AP4M_AGENT_ROLE ?? "inspector") as Role;
  return key ? new ethers.Wallet(key, provider()) : new ethers.Wallet(wallet(role).privateKey, provider());
}

/** Wallet that sends voucher redemptions for the merchant (needs XRP for gas). */
export function merchantSubmitter(): ethers.Wallet {
  const key = process.env.MERCHANT_SUBMITTER_KEY;
  return key ? new ethers.Wallet(key, provider()) : new ethers.Wallet(wallet("checkService").privateKey, provider());
}

export async function session() {
  return sdk.signIn(AP4M_API_URL, need("AP4M_TEAM_NAME"), ap4mAgentWallet());
}

/** Use AP4M_CHANNEL_ID, else an open Channel, else request a new one with AP4M_CHANNEL_CAP RLUSD. */
export async function ensureChannel(): Promise<string> {
  if (process.env.AP4M_CHANNEL_ID) return process.env.AP4M_CHANNEL_ID;
  const { token } = await session();
  const open = (await sdk.listChannels(AP4M_API_URL, token)).find((c: { channel_status: string }) => c.channel_status === "open");
  if (open) return open.channel_id;
  const ch = await sdk.requestChannel(AP4M_API_URL, token, ap4mAgentWallet(), {
    capRlusd: process.env.AP4M_CHANNEL_CAP ?? "0.2",
    merchantId: process.env.MERCHANT_ID,
    rpcUrl: RPC_URL,
  });
  return ch.channel_id;
}

export function resourceUrl(type: CheckType): string {
  const i = CHECK_TYPES.indexOf(type);
  return `http://localhost:${MERCHANT_BASE_PORT + i}/resource`;
}

export interface Ap4mPayment { type: CheckType; amountWei: string; txHash: string; claimId: string; explorer: string; at: string }

/** Agent side: buys checks with vouchers, enforcing the same caps as the XRP rail. */
export class Ap4mBuyer {
  readonly wallet = ap4mAgentWallet();
  readonly price = toWei(process.env.CHECK_PRICE_RLUSD ?? CHECK_PRICE);
  readonly perCallCap = toWei(process.env.AGENT_MAX_PER_CALL_RLUSD ?? AGENT_MAX_PER_CALL);
  readonly sessionCap = toWei(process.env.AGENT_BUDGET_RLUSD ?? AGENT_BUDGET);
  readonly runId = Date.now().toString(36);
  spent = 0n;
  payments: Ap4mPayment[] = [];
  private channelId?: string;
  private ctx?: Awaited<ReturnType<typeof loadX402Context>>;

  async buy(type: CheckType, phaseId: bigint) {
    if (this.price > this.perCallCap) throw new Error(`price ${rlusd(this.price)} exceeds per-call limit ${rlusd(this.perCallCap)}`);
    if (this.spent + this.price > this.sessionCap) throw new Error(`would exceed session budget (${rlusd(this.sessionCap - this.spent)} left)`);
    this.ctx ??= await loadX402Context(AP4M_API_URL);
    this.channelId ??= await ensureChannel();
    // Same operation name per deal+check: a retry or a rerun resumes the purchase and never pays twice.
    const args = {
      context: this.ctx,
      provider: provider(),
      wallet: this.wallet,
      stateDirectory: `${STATE_DIR}/agent`,
      resourceUrl: resourceUrl(type),
      channelId: this.channelId,
      maximumAmount: this.perCallCap.toString(),
      operation: `d${loadDeployment().escrow.slice(2, 8).toLowerCase()}-${phaseId}-${type}`,
    };
    let r: Awaited<ReturnType<typeof buyResource>> | undefined;
    for (let attempt = 1; !r; attempt++) {
      try { r = await buyResource(args); } catch (e) {
        // 503 while the chain finalizes the redemption: resume the same operation, as the kit instructs.
        const retry = e instanceof Error && /resume the same operation|waiting for a new chain block/.test(e.message);
        if (!retry || attempt >= 12) throw e;
        await new Promise((res) => setTimeout(res, 10_000));
      }
    }
    this.spent += this.price;
    const payment: Ap4mPayment = {
      type, amountWei: this.price.toString(), txHash: r.transactionHash, claimId: r.claimId,
      explorer: `${process.env.EXPLORER ?? "https://explorer.testnet.xrplevm.org"}/tx/${r.transactionHash}`, at: new Date().toISOString(),
    };
    this.payments.push(payment);
    return { body: r.resource as Record<string, unknown>, payment };
  }

  async budget() {
    return {
      address: this.wallet.address, rail: "ap4m/RLUSD", channelId: this.channelId ?? "(opens on first purchase)",
      sessionCap: rlusd(this.sessionCap), spentThisSession: rlusd(this.spent), remainingThisSession: rlusd(this.sessionCap - this.spent),
    };
  }
}

/** Merchant side: one fixed-price x402 resource per check type, one port each. */
export async function startMerchants(content: (type: CheckType) => Record<string, unknown>) {
  const ctx = await loadX402Context(AP4M_API_URL);
  const closers: Array<() => Promise<void>> = [];
  for (const [i, type] of CHECK_TYPES.entries()) {
    const m = createX402Merchant({
      context: ctx,
      provider: provider(),
      submitter: merchantSubmitter(),
      stateDirectory: `${STATE_DIR}/merchant-${type}`,
      resourceUrl: resourceUrl(type),
      merchantParticipantId: need("MERCHANT_ID"),
      payout: need("MERCHANT_PAYOUT"),
      amount: toWei(process.env.CHECK_PRICE_RLUSD ?? CHECK_PRICE).toString(),
      content: content(type),
    });
    await new Promise<void>((resolve) => m.server.listen(MERCHANT_BASE_PORT + i, resolve));
    console.log(`  ${type.padEnd(10)} ${resourceUrl(type)}`);
    closers.push(m.close);
  }
  return async () => { for (const c of closers) await c(); };
}

export { sdk };
