// Deploys RealEstateEscrow and signs the contract: the buyer deposits 10% of the price
// into the seller's attorney escrow. Usage: npm run deploy -- [dealId] ["property"]
import fs from "node:fs";
import { ethers } from "ethers";
import { CHAIN_ID, DEPLOYMENT_FILE, PRICE, PROPERTY, fmt, loadArtifact, txLink, txSigner, wallet } from "../src/config.js";
import { announce } from "../src/announce.js";

const dealId = BigInt(process.argv[2] ?? 1);
const property = process.argv[3] ?? PROPERTY;

const buyer = txSigner("buyer");
const { abi, bytecode } = loadArtifact();

let escrowAddress: string;
if (fs.existsSync(DEPLOYMENT_FILE) && !process.env.REDEPLOY) {
  escrowAddress = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8")).escrow;
  console.log(`Reusing escrow ${escrowAddress} (set REDEPLOY=1 for a fresh one)`);
} else {
  const factory = new ethers.ContractFactory(abi, bytecode, buyer);
  const c = await factory.deploy(wallet("seller").address, wallet("attorney").address, wallet("inspector").address);
  console.log(`Deploying... ${txLink(c.deploymentTransaction()!.hash)}`);
  await c.waitForDeployment();
  escrowAddress = await c.getAddress();
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify({ escrow: escrowAddress, chainId: CHAIN_ID, deployedAt: new Date().toISOString() }, null, 2));
  console.log(`RealEstateEscrow deployed at ${escrowAddress}`);
}

const escrow = new ethers.Contract(escrowAddress, abi, buyer);
const existing = await escrow.deals(dealId);
if (Number(existing.status) !== 0) {
  console.log(`Deal ${dealId} already exists (status ${existing.status}); not opening again.`);
} else {
  const price = ethers.parseEther(PRICE);
  const deposit = price / 10n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  const tx = await escrow.openDeal(dealId, price, deadline, property, { value: deposit });
  console.log(`Buyer signs contract and deposits 10% (${fmt(deposit)} of ${fmt(price)}) ... ${txLink(tx.hash)}`);
  await announce(escrow, await tx.wait());
}
