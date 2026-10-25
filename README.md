<p align="center"><img src="logo.svg" width="120" alt="RealestateTransaction logo"></p>

# RealestateTransaction

An AI agent runs a home purchase: the 10% deposit sits in the seller's attorney escrow on XRPL EVM and is paid out only after inspection, final walkthrough, and buyer + seller approval.

Built for the **AI & Fintech XRPL Hackathon** (NYC, Oct 24-25, 2026): Mastercard AP4M agentic payments track + AWS (Amazon Bedrock) bounty.

---

## Project description

### The problem
Buying a home moves a large deposit between strangers on trust. The buyer wires 10% to the seller's side, then waits on inspections, walkthroughs and paperwork, with no clear view of who has done what and no automatic protection if the deal falls through. Everyone chases updates by phone and email.

### What it does
**RealestateTransaction** runs the deposit stage of a home purchase as an escrow on XRPL EVM, supervised by an AI agent.

1. **Sign and deposit.** The buyer signs the contract and deposits exactly 10% of the price into the seller's attorney's escrow account. The contract enforces the amount. The seller cannot touch it.
2. **Human inspection.** A real home inspector writes the report and uploads documents (PDF, photos, notes) on their own page, then types **yes** or **no** in an inspection verification box (does the home pass?). A "no", or any failed item, fails the report. The attorney, buyer and seller can post messages and documents on theirs.
3. **The AI agent checks everything.** An agent on Amazon Bedrock confirms the deposit is really in escrow on-chain, reads the inspector's report, the documents and every message, and pays for four independent cross-checks (structure, roof, systems, pests) from x402 merchants, paid in RLUSD with Mastercard AP4M Channel vouchers. It then records PASSED or FAILED on-chain, which approves or blocks the next stage.
4. **Final walkthrough.** The buyer walks through the home one last time and records the result on the buyer page.
5. **Both say OK.** The buyer and the seller each approve. The moment both have, the contract pays the deposit to the seller and the deal is closed.
6. **If anything fails,** the seller's attorney cancels and the buyer gets the full deposit back.

### What makes it special
- **Money moves only on proof.** Release requires a passed inspection, a passed walkthrough and two human approvals, all enforced by the smart contract. The AI never holds or moves the deposit.
- **An agent that does the legwork.** It waits for people, reads what they write, pays for checks, and sends clear "From → To" messages (for example "Agent to Buyer: time for your final walkthrough").
- **Guardrails in code, not just prompts.** The agent will not spend until the deposit is confirmed, has spending caps, and the code refuses a PASS unless the report and every check agree. It cannot approve for the buyer, seller or attorney.
- **Everyone is kept informed.** Each event sends an email and pops up as a floating message card on a live dashboard, with a full audit trail and explorer links.
- **Real agent payments.** Checks are bought with Mastercard AP4M: the agent opens an RLUSD payment Channel and signs vouchers, the merchant redeems them on-chain, and each payment gets a verifiable receipt.

### Status (honest)
- **Full deal closed on XRPL EVM Testnet, driven by the Amazon Bedrock agent:** deposit verified on-chain, inspector's document and messages read, four checks paid with **AP4M RLUSD vouchers** (0.04 RLUSD, each redeemed on-chain), PASS recorded, final walkthrough, seller and buyer approval, and the 0.5 XRP deposit released to the seller. Emails were delivered at each step. Transactions are listed below.
- **Mocked:** the inspection check results (stand in for real inspection/title services). Portal actions are signed with demo testnet wallets held by the server.
- **Not built yet:** PDF/photo understanding (only `.txt`/`.md` documents are read as text; others are listed and fingerprinted), RLUSD-denominated deposits, a bank/USD payout choice for the attorney.

### Where it goes next
Real inspector and title-company integrations, RLUSD deposits, a bank or USD payout choice for the attorney, PDF/photo analysis with a vision model, and production key custody (AWS KMS) instead of demo wallets.

---

## Technical description

**Contract:** Solidity 0.8.24 `RealEstateEscrow` on XRPL EVM Testnet. 10% deposit enforced on-chain; release needs inspection pass + walkthrough pass + buyer OK + seller OK; attorney cancel refunds the buyer.

**Agent:** Amazon Bedrock (Converse tool use, Claude) verifies the deposit on-chain, reads the human inspector's portal report, uploaded documents and party messages, buys 4 cross-checks from x402 merchants paid in RLUSD via Mastercard AP4M Channel vouchers (redeemed on-chain, with receipts), then records PASS/FAIL on-chain.

**Guardrails in code, not prompts:** no spend without a confirmed deposit, spend caps, idempotent purchases, PASS refused unless report and all checks pass. The agent cannot sign for buyer, seller or attorney.

**Stack:** TypeScript, ethers v6, Express portal (inspector/buyer/seller/attorney), SHA-256 document fingerprints, nodemailer From→To emails, live dashboard.

**Mocked:** check results; portal actions use demo testnet wallets.

---

## How it works

```
Buyer ──10% deposit──▶ RealEstateEscrow (seller's attorney escrow)
                              │
 Inspector ──report + documents──▶ Portal ◀── Attorney / Buyer / Seller messages + documents
                              │
        Deal agent (Amazon Bedrock) reads chain + portal
          │  pays 4 checks: AP4M RLUSD Channel vouchers (x402)
          ▼
   recordInspection(PASS/FAIL) ──▶ Buyer: final walkthrough ──▶ Buyer OK + Seller OK
                                                                    │
                                          deposit ──▶ Seller, deal closed
                                          (or Attorney cancels ──▶ deposit back to Buyer)
```

| Role | Wallet index (from `MNEMONIC`) | What it does |
|---|---|---|
| buyer | 0 | signs the contract, deposits 10%, walkthrough, approves; also the AP4M agent wallet |
| inspector | 1 | the AI agent's on-chain identity: records the inspection result |
| attorney | 2 | holds the escrow, can cancel and refund |
| checkService | 3 | submits merchant voucher redemptions (needs gas) |
| seller | 4 | approves, receives the deposit |

## Contract intake (optional start of the demo)

Instead of opening the escrow at a fixed 10%, the agent can start from the **purchase contract**. The seller's attorney uploads a contract on the attorney page (file name must contain "contract"). The agent reads the **contract date** and the **deposit percentage (10% or 20%)** and only then opens the escrow with that deposit. If the contract cannot be read (PDF or image, missing or conflicting date, an unsupported percentage), nothing is executed: the agent emails the buyer and attorney and waits for a new upload.

```powershell
$env:INTAKE="1"; $env:REDEPLOY="1"; npm run deploy   # deploys the escrow only
npm run intake -- 1                                  # waits for the attorney's contract, then opens the escrow
```

Sample contracts to upload are in `sample-contracts/`: `purchase-contract-10pct.txt`, `purchase-contract-20pct.txt`, and `purchase-contract-unreadable.txt` (15% deposit and no date, to show the email path). Reading is deterministic first; with `AGENT_MODE=bedrock` an Amazon Bedrock call is a fallback for unusual wording, and its answer is re-validated in code. `npm test` runs the offline parser tests. Only `.txt` and `.md` contracts are read for now.

## Demo pages

| Page | URL |
|---|---|
| Dashboard (money flow, balloons, agent activity) | http://localhost:3000 |
| Inspector (report, documents, messages) | http://localhost:3100/inspector |
| Buyer (walkthrough, approve, messages) | http://localhost:3100/buyer |
| Seller (approve, messages) | http://localhost:3100/seller |
| Attorney (cancel and refund, messages) | http://localhost:3100/attorney |

## Quick start (Windows PowerShell)

```powershell
npm install
Copy-Item .env.example .env     # put your TESTNET mnemonic and SMTP password in .env
npm run compile                 # builds the Solidity contract
npm run setup                   # shows role addresses, funds the other roles with gas
$env:REDEPLOY="1"; npm run deploy   # deploys the escrow and deposits 10% for deal 1
```

Then run each of these in its own terminal (same folder):

```powershell
npm run dashboard               # 1  http://localhost:3000
npm run portal                  # 2  http://localhost:3100
npm run ap4m:merchant           # 3  AP4M check merchants (PAYMENTS=ap4m). For XRP payments run `npm run service` instead
npm run orchestrate -- 1        # 4  the Bedrock deal agent
```

Demo order: inspector uploads a document, types yes/no in the verification box and submits the report → agent verifies and records PASS → buyer records the final walkthrough → seller approves → buyer approves → deal closes.
Failure demo: submit a report with a failed item; the agent records FAIL; the attorney cancels on the attorney page and the buyer gets the deposit back.

Handy commands: `npm run status -- 1` (on-chain history), `npm run ap4m -- status|settle|close` (AP4M Channel), `npm run deal -- <action> 1` (command-line version of the portal buttons).

## Configuration (`.env`)

See `.env.example`. Key settings: `MNEMONIC` (testnet only), `AGENT_MODE=bedrock|rules`, `AWS_REGION`, `BEDROCK_MODEL_ID`, `AWS_CREDENTIALS_FILE` (PowerShell-style file with temporary AWS credentials), `PAYMENTS=ap4m|xrp`, `AP4M_TEAM_NAME`, `MERCHANT_ID`, `MERCHANT_PAYOUT`, `AP4M_AGENT_ROLE=buyer`, `SMTP_*` and `NOTIFY_TO` (all emails go to one mailbox; the subject says "Seller to Attorney message", etc.; SMTP certificate checking is disabled for the hackathon mail host).

`AGENT_MODE=rules` runs the same flow without AWS and makes a reliable fallback. The deal agent checks the AWS credentials at start and falls back to rules mode by itself if they are expired. `npm run aws:check` tests the token; `npm run aws:renew` (optionally `-- --watch`) re-assumes the role to refresh it, which only works while the token is still valid and the role can assume itself. The AWS Workshop role cannot, so there you paste fresh credentials into `AWS_CREDENTIALS_FILE`; it is re-read on every Bedrock call, so no restart is needed. `PAYMENTS=xrp` pays checks in native XRP (x402-style) instead of AP4M.

## Live testnet evidence

- Chain: XRPL EVM Testnet (chain ID 1449000), explorer https://explorer.testnet.xrplevm.org
- Escrow contract: `0x2D8d42F297532564b072CbC58556599F55D6CBF3`
- Full closing (deal 1, 24 Linden Ave), every step on-chain:
  - Deposit locked: https://explorer.testnet.xrplevm.org/tx/0xd2b44047265d9d7b10f2773a2484f3e286c376539d056077054c36b9903e6218
  - Inspection PASS recorded by the agent: https://explorer.testnet.xrplevm.org/tx/0xc4d96f37f914cf979b8c50004a88044459663b50362b60137132a36574f3272d
  - Final walkthrough: https://explorer.testnet.xrplevm.org/tx/0x17718174cdb7acfa3d1fca0a2c4c44f7d04cdfb0a62060ea0f5c8722f6b76bd6
  - Seller approved: https://explorer.testnet.xrplevm.org/tx/0x3aa2d3970bb8259083d8885549cc46eb0416160e64384f70deb69f90193f92a9
  - Buyer approved and deal closed (deposit paid to seller): https://explorer.testnet.xrplevm.org/tx/0xdd1f2c67fd7746d6ab6426e0561b8ced6d4283caa143d0418df653761b1fbdad
- AP4M check payments (RLUSD voucher redemptions):
  - structure: https://explorer.testnet.xrplevm.org/tx/0xa87238d39644ee3a753c3526ba205a6dc5324ed3f513898d3d0c162a03870604
  - roof: https://explorer.testnet.xrplevm.org/tx/0xc2c117b62d23306bb2b9cba31923c54b45eee5ff5056b7b3b20e9380bfd54019
  - systems: https://explorer.testnet.xrplevm.org/tx/0x7ad6d8bab13347ee804a9ea49c4ed1c6dded5df994808c8b85d97ad4ef6a8144
  - pests: https://explorer.testnet.xrplevm.org/tx/0x7e604565c08e3715dcf1a4ac70f6780a649734ec624f448866e7c48da1599fa5
- AP4M Channel: `0x1983d9a085bd303a2ed5e8d2efccdf5b022a17a2c95e70c012a21b0aa953c61d`
- AP4M voucher redemption (0.01 RLUSD): https://explorer.testnet.xrplevm.org/tx/0xb6f7c97d3cbdd9ee98ff48f39aab8719171a96f8c8bcc16cf00c3804673a611c
- AP4M receipt: `https://hackathon.ap4m.build/public/evidence/claims/0x71f7b0a2252a15e43a42308a83d01d8048917b253a93718d042b1d76bc76b331/0x539aae7bd81af3253741d9ffbaca343e64faf669f85a0bc6c30b977007ad20a1.json`

## Files

| Path | What it does |
|---|---|
| `contracts/RealEstateEscrow.sol` | Escrow: 10% deposit, inspection, walkthrough, two approvals, cancel/refund |
| `src/orchestrator.ts` | The deal agent (Bedrock tool-use loop, or deterministic rules mode) |
| `src/agent.ts` | Inspection session: deposit verification, paid checks, guardrails, audit file |
| `src/ap4m.ts`, `ap4m-x402.mjs`, `ap4m-hackathon-sdk.cjs` | Mastercard AP4M rail: Channels, vouchers, x402 buyer and merchant |
| `src/portal.ts` | Role pages, document uploads, messages, signed demo actions |
| `src/dashboard.ts` | Live dashboard with money flow, message balloons, agent activity |
| `src/messages.ts`, `src/announce.ts` | "From → To" messages shared by balloons and emails; SMTP sender |
| `src/service.ts`, `src/payments.ts` | XRP-based x402 check service and spending-capped agent wallet (`PAYMENTS=xrp`) |
| `scripts/` | compile, setup, deploy, deal (CLI actions), status, ap4m |
| `legacy/` | The earlier construction-milestone version of this project |

## Safety notes

- Everything is **testnet only**. The mnemonic lives in `.env` (gitignored); never reuse a wallet that held real funds, and never commit `.env`, `awscredential.txt`, `uploads/`, `audit/` or `.ap4m-state/`.
- The agent's guardrails are enforced in code: no spending without a confirmed deposit, per-call and session caps, no PASS without a passing portal report and all checks, and it cannot sign for the buyer, seller or attorney.
- The portal binds to `127.0.0.1` and is a local demo, not an authenticated production service.
