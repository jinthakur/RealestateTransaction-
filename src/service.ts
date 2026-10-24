// Paid verification service (x402-style) on XRPL EVM.
//
//   GET /checks/:type?sub=0x...&phase=1
//     no X-PAYMENT header -> 402 with payment requirements and a one-time nonce
//     X-PAYMENT: base64({"txHash","nonce"}) -> verifies the payment on-chain, returns the result
//
// The payment proof is a native XRP transfer to the service address whose
// calldata is the nonce, so one payment can only unlock one request.
//
// Check results are MOCK data standing in for real sources (licensing
// registries, insurance carriers, a vision model on site photos).
import express from "express";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { CHAIN_ID, CHECK_PRICE, PROPERTY, provider, wallet } from "./config.js";
import { CHECK_TYPES, type CheckType, mockResult } from "./mock-checks.js";

const PORT = Number(process.env.PORT ?? 4020);
const SCENARIO = (process.env.SCENARIO ?? "pass").toLowerCase(); // "pass" | "fail"
const PAY_TO = wallet("checkService").address;
const PRICE = ethers.parseEther(CHECK_PRICE);
const NONCE_TTL_MS = 10 * 60 * 1000;


const pending = new Map<string, { type: CheckType; expires: number }>();
const spentTx = new Set<string>();
const p = provider();

async function verifyPayment(header: string, type: CheckType): Promise<string | null> {
  let proof: { txHash?: string; nonce?: string };
  try {
    proof = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return "X-PAYMENT is not base64 JSON";
  }
  const { txHash, nonce } = proof;
  if (!txHash || !nonce) return "X-PAYMENT needs txHash and nonce";

  const quote = pending.get(nonce);
  if (!quote) return "unknown or already-used nonce";
  if (quote.type !== type) return "nonce was issued for a different check";
  if (Date.now() > quote.expires) return "nonce expired";
  if (spentTx.has(txHash.toLowerCase())) return "payment already used";

  const [tx, receipt] = await Promise.all([p.getTransaction(txHash), p.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) return "transaction not found or not mined yet";
  if (receipt.status !== 1) return "transaction failed";
  if (Number(tx.chainId) !== CHAIN_ID) return "wrong chain";
  if (tx.to?.toLowerCase() !== PAY_TO.toLowerCase()) return "paid the wrong address";
  if (tx.value < PRICE) return "underpaid";
  if (tx.data !== ethers.hexlify(ethers.toUtf8Bytes(nonce))) return "payment not bound to this nonce";

  pending.delete(nonce);
  spentTx.add(txHash.toLowerCase());
  return null;
}

const app = express();

app.get("/checks/:type", async (req, res) => {
  const type = req.params.type as CheckType;
  if (!CHECK_TYPES.includes(type)) {
    return res.status(404).json({ error: `unknown check; use one of ${CHECK_TYPES.join(", ")}` });
  }
  const sub = String(req.query.sub ?? "");
  const phase = String(req.query.phase ?? "1");

  const header = req.header("X-PAYMENT");
  if (!header) {
    const nonce = crypto.randomBytes(16).toString("hex");
    pending.set(nonce, { type, expires: Date.now() + NONCE_TTL_MS });
    return res.status(402).json({
      error: "payment_required",
      accepts: [{
        scheme: "exact",
        network: "xrpl-evm",
        chainId: CHAIN_ID,
        asset: "XRP",
        payTo: PAY_TO,
        amount: PRICE.toString(),
        nonce,
        resource: req.originalUrl,
        description: `${type} check`,
        expiresAt: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
      }],
    });
  }

  try {
    const problem = await verifyPayment(header, type);
    if (problem) return res.status(402).json({ error: "payment_invalid", reason: problem });
  } catch (e) {
    return res.status(502).json({ error: "could not reach the chain to verify payment", detail: String(e) });
  }

  const result = mockResult(type, PROPERTY, SCENARIO === "fail");
  res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ settled: true })).toString("base64"));
  return res.json({ check: type, ...result });
});

app.get("/health", (_req, res) => res.json({ ok: true, payTo: PAY_TO, price: CHECK_PRICE, scenario: SCENARIO }));

app.listen(PORT, () => {
  console.log(`Check service on http://localhost:${PORT}  payTo=${PAY_TO}  price=${CHECK_PRICE} XRP  scenario=${SCENARIO}`);
});
