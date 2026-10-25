# RealestateTransaction: context for Claude

## What this is
Hackathon entry for the **AI & Fintech XRPL Hackathon** (NYC, Oct 24-25, 2026): **Mastercard AP4M / Agentic Payments** track plus the AWS (Amazon Bedrock) bounty.
An AI agent runs the deposit stage of a home purchase. The buyer's 10% deposit sits in the seller's attorney escrow (`RealEstateEscrow`, XRPL EVM Testnet).
The agent verifies the deposit on-chain, reads the human inspector's portal report, documents and party messages, pays for four cross-checks
(structure, roof, systems, pests) with AP4M RLUSD Channel vouchers (x402), then records PASS/FAIL on-chain. Release to the seller needs a passed inspection,
a passed walkthrough, buyer OK and seller OK. If it fails, the attorney cancels and the buyer is refunded. See `README.md` for the full description and live tx evidence.

## Stack
- XRPL EVM **Testnet**: chain ID 1449000, RPC https://rpc.testnet.xrplevm.org, explorer https://explorer.testnet.xrplevm.org. Native token XRP, 18 decimals. RLUSD has 18 decimals.
- TypeScript + ethers v6 run with `tsx`; Solidity 0.8.24 compiled with solc-js. Express portal (inspector/buyer/seller/attorney), live dashboard, nodemailer emails.
- Agent brain: `AGENT_MODE=bedrock` (Amazon Bedrock Converse tool use, creds from `AWS_CREDENTIALS_FILE`) or `rules` (deterministic, no AWS; reliable fallback).
- Payments: `PAYMENTS=ap4m` (Mastercard AP4M RLUSD vouchers) or `xrp` (native XRP x402-style via `npm run service`).
- Developer is on Windows / PowerShell.

## Roles (derived from MNEMONIC, path m/44'/60'/0'/0/i)
| i | role | notes |
|---|---|---|
| 0 | buyer | funded wallet; deploys escrow, deposits 10%, walkthrough, approves; also the AP4M agent wallet (`AP4M_AGENT_ROLE=buyer`) |
| 1 | inspector | the AI agent's on-chain identity; records the inspection result |
| 2 | attorney | holds the escrow; can cancel and refund |
| 3 | checkService | submits merchant voucher redemptions (needs gas) |
| 4 | seller | approves, receives the deposit |

## Commands
`compile` -> `setup` -> `REDEPLOY=1 deploy` -> then each in its own terminal: `dashboard` (:3000), `portal` (:3100), `ap4m:merchant` (or `service` for XRP mode), `orchestrate -- 1`.
Also `status -- 1`, `ap4m -- status|settle|close`, `deal -- <action> 1`, `typecheck`.
Demo order: inspector uploads a document, types **yes/no** in the inspection verification box and submits -> agent pays checks and records PASS -> buyer walkthrough -> seller OK -> buyer OK -> deal closes.

## Contract intake
`INTAKE=1 REDEPLOY=1 npm run deploy` deploys only; `npm run intake -- 1` waits for a contract uploaded on the **attorney** page (file name contains "contract"), reads the contract date and a 10% or 20% deposit (`src/contract.ts`, regex first, Bedrock fallback), then calls `openDeal(dealId, price, depositBps, ...)`. Unreadable contract: no execution, email to buyer and attorney, wait for a new upload. The contract only accepts 1000 or 2000 bps. Samples in `sample-contracts/`, tests via `npm test`. The escrow ABI changed (new `depositBps`), so an old `deployment.json` needs `REDEPLOY=1`.

## AWS credentials
`AWS_CREDENTIALS_FILE` is re-read on every Bedrock call (`awsClientConfig` in `src/config.ts`). `npm run aws:check` / `aws:renew` use STS; the Workshop role cannot assume itself, so renewal there means pasting new credentials. The orchestrator falls back to rules mode when AWS is unusable. Log range lookback defaults to 2000 blocks (`LOG_LOOKBACK`) because the testnet RPC rejects large ranges.

## Inspection verification
The inspector page has a text box where the inspector types `yes` or `no` (does the home pass?). The portal rejects anything else. PASS requires `yes` AND every item passing; `no` always fails the report, and the agent cannot pass over a failed report.

## State
- A full deal closed on XRPL EVM Testnet, driven by the Bedrock agent, with four AP4M RLUSD voucher payments redeemed on-chain (hashes in README).
- Mocked: inspection check results (stand-ins for real inspection/title services); portal actions are signed by demo testnet wallets held by the server.
- Only the contract parser has automated tests (`npm test`); there are none for `RealEstateEscrow` itself, and the new intake flow has not been run on-chain yet. `legacy/guardrails.ts` belongs to the old milestone-escrow version and is not wired up.

## Rules for working on this
- Never print, log or commit MNEMONIC, private keys, SMTP password or AWS credentials. `.env`, `.ap4m-state/`, `uploads/`, `audit/`, `portal-data.json` and `awscredential.txt` stay out of git.
- Testnet wallets only; never fund them with real money.
- Send transactions through the NonceManager signer helpers in `src/config.ts`, not a bare wallet; public RPCs return stale nonces right after a tx mines.
- Keep the guardrails in code (`src/agent.ts`, escrow contract), not only in the prompt: no spend without a confirmed deposit, spend caps, idempotent purchases, no PASS unless the report and all checks pass, agent cannot act for buyer/seller/attorney.
- `legacy/` is the earlier construction-milestone project; do not extend it.
