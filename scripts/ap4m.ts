// AP4M helper commands.
//   npm run ap4m -- channel   open (or show) the payment Channel for the agent
//   npm run ap4m -- status    channel cap / redeemed / expiry
//   npm run ap4m -- settle    settle redeemed vouchers, print receipt URL(s)
//   npm run ap4m -- close     close the Channel
import { AP4M_API_URL, ap4mAgentWallet, ensureChannel, rlusd, sdk, session } from "../src/ap4m.js";
import { provider } from "../src/config.js";

const cmd = process.argv[2] ?? "status";
const ctx = await (await fetch(`${AP4M_API_URL}/public/config`)).json() as { contracts: { paymentLedger: string } };

if (cmd === "channel") {
  console.log("Channel:", await ensureChannel());
} else if (cmd === "status") {
  const id = await ensureChannel();
  const s = await sdk.getChannelState(provider(), ctx.contracts.paymentLedger, id);
  console.log({ channelId: id, cap: rlusd(s.cap), redeemed: rlusd(s.redeemed), validBefore: new Date(Number(s.validBefore) * 1000).toISOString(), status: Number(s.status) });
} else if (cmd === "settle") {
  const { token } = await session();
  const r = await sdk.settle(AP4M_API_URL, token, process.env.AP4M_CHANNEL_ID);
  console.log(`Settled ${r.amount_rlusd} RLUSD to ${r.recipient} (${r.claims_settled} claims)`);
  console.log("Receipt:", r.receipt_url ?? r.receipts);
} else if (cmd === "close") {
  const { token } = await session();
  console.log(await sdk.closeChannel(AP4M_API_URL, token, ap4mAgentWallet(), process.env.AP4M_CHANNEL_ID));
} else {
  console.log("usage: npm run ap4m -- channel|status|settle|close");
}
