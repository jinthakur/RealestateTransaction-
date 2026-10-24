# SiteEscrow: context for Claude

## What this is
Hackathon entry for the **AI & Fintech XRPL Hackathon** (NYC, Oct 24–25, 2026), aimed at the
**Mastercard AP4M / Agentic Payments** track plus the AWS bounty. An AI inspection agent pays for
verification checks (x402-style), then casts one of the two approvals a construction-phase escrow
needs. The escrow releases to the subcontractor only on 2 of 3 approvals (contractor, human
inspector, AI agent). Domain: NYC school construction milestone payments.

## Stack
- XRPL EVM **Testnet**: chain ID 1449000, RPC https://rpc.testnet.xrplevm.org, explorer https://explorer.testnet.xrplevm.org. Native token XRP, 18 decimals.
- TypeScript + ethers v6, run with `tsx`. Solidity 0.8.24 compiled with solc-js (`evmVersion: paris`).
- Agent brain: `AGENT_MODE=rules` (no AWS) or `bedrock` (Amazon Bedrock Converse tool use, us-east-1, credentials from the AWS Workshop Studio event account).
- Developer is on Windows / PowerShell.

## Roles (all derived from MNEMONIC in .env, path m/44'/60'/0'/0/i)
| i | role | notes |
|---|---|---|
| 0 | contractor | the funded wallet; deploys escrow, funds phases, funds the others via `npm run setup` |
| 1 | agent | spending budget + gas |
| 2 | inspector | gas only |
| 3 | checkService | payee of the paid check service |
| 4 | subcontractor | receives released funds |

## Commands
`compile` → `setup` → `deploy [-- phaseId "desc"]` → `service` (separate terminal; `SCENARIO=fail` to fail photos) → `agent -- phaseId` → `approve -- phaseId [inspector|contractor]` → `status -- phaseId`. `typecheck`, `test:guardrails` (local ganache chain only; see README).

## State as of handoff
- Full flow verified on a local ganache chain (chain ID 1449000): pay 4 checks → agent approves → inspector approves → 0.5 XRP released. Fail scenario → agent declines, no approval.
- `test:guardrails`: 15/15 pass (replay/forged/underpaid/misdirected payments, spend caps, allowlist, agent can't approve without all checks passing, contract access control).
- **Not yet run:** live XRPL EVM Testnet, and Bedrock mode against real AWS.
- Check *results* are mock data. The 402 flow is x402-style, not the official XRPL x402 facilitator or AP4M SDK.

## Rules for working on this
- Never print, log, or commit MNEMONIC or private keys. `.env` is gitignored; keep it that way.
- This wallet is testnet-only. Its secrets were shared in a chat, so it must never hold real funds.
- Send transactions through `txSigner(role)` (ethers NonceManager), not `wallet(role)`. Public RPCs return stale nonces right after a tx mines.
- Keep the code-level guardrails in `approveRelease` and `AgentWallet.check`. Don't move them into the prompt only.

## Likely next steps
1. First live testnet run once the Mastercard funding lands; fix any RPC quirks (gas price, log range limits in `status.ts`).
2. Bedrock mode with the workshop credentials; confirm the model ID via `aws bedrock list-inference-profiles`.
3. Stretch: swap the x402-style flow for the XRPL x402 facilitator / Mastercard Verifiable Intent; pay checks in RLUSD; a small web dashboard for the demo.
