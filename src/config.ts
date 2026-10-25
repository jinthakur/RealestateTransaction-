import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

// Optional: temporary AWS credentials in a PowerShell-style file ($Env:NAME="value" lines),
// so every terminal works without dot-sourcing it. The file is re-read whenever Bedrock is
// called (see awsClientConfig), so `npm run aws:renew` takes effect without restarting anything.
export function readAwsCredentialsFile(): Record<string, string> {
  const file = process.env.AWS_CREDENTIALS_FILE;
  const out: Record<string, string> = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const m of fs.readFileSync(file, "utf8").matchAll(/\$Env:(\w+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Client config for AWS SDK clients: region plus credentials from the file (fresh on every use), else the default chain. */
export function awsClientConfig() {
  const region = process.env.AWS_REGION ?? "us-east-1";
  if (!process.env.AWS_CREDENTIALS_FILE) return { region };
  return {
    region,
    credentials: async () => {
      const c = readAwsCredentialsFile();
      if (!c.AWS_ACCESS_KEY_ID || !c.AWS_SECRET_ACCESS_KEY) throw new Error(`no AWS credentials in ${process.env.AWS_CREDENTIALS_FILE}`);
      return { accessKeyId: c.AWS_ACCESS_KEY_ID, secretAccessKey: c.AWS_SECRET_ACCESS_KEY, sessionToken: c.AWS_SESSION_TOKEN };
    },
  };
}

export const RPC_URL =process.env.RPC_URL ?? "https://rpc.testnet.xrplevm.org";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 1449000);
export const EXPLORER = process.env.EXPLORER ?? "https://explorer.testnet.xrplevm.org";
export const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:4020";

// Demo amounts (native XRP on XRPL EVM, 18 decimals). Keep them small on testnet.
export const PRICE = process.env.PRICE ?? "5";                      // home price; 10% goes into attorney escrow
export const PROPERTY = process.env.PROPERTY ?? "24 Linden Ave, Brooklyn NY (demo listing)";
export const AGENT_BUDGET = process.env.AGENT_BUDGET ?? "0.1";      // session cap for the agent
export const AGENT_MAX_PER_CALL = process.env.AGENT_MAX_PER_CALL ?? "0.02";
export const CHECK_PRICE = process.env.CHECK_PRICE ?? "0.01";       // price per paid check
export const GAS_TOPUP = process.env.GAS_TOPUP ?? "0.05";           // gas money for the inspector

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEPLOYMENT_FILE = path.join(ROOT, "deployment.json");
export const ARTIFACT_FILE = path.join(ROOT, "artifacts", "RealEstateEscrow.json");
export const AUDIT_DIR = path.join(ROOT, "audit");
export const AGENT_LOG = path.join(ROOT, "agent-log.jsonl");
export const PORTAL_URL = process.env.PORTAL_URL ?? "http://localhost:3100";

let sharedProvider: ethers.JsonRpcProvider | undefined;
export function provider(): ethers.JsonRpcProvider {
  sharedProvider ??= new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  return sharedProvider;
}

/**
 * Every demo role is derived from ONE mnemonic, so a single funded testnet
 * wallet (index 0, the address ethers.Wallet.createRandom() printed) can fund
 * the rest. Never use this pattern with a mainnet wallet.
 */
export const ROLE_INDEX = {
  buyer: 0,          // your funded wallet: signs the contract, deposits 10%
  inspector: 1,      // AI home-inspection agent: pays for checks, records the result
  attorney: 2,       // seller's attorney: holds the escrow account
  checkService: 3,   // payee of the paid inspection-check service
  seller: 4,         // receives the deposit when the deal closes
} as const;
export type Role = keyof typeof ROLE_INDEX;

export function wallet(role: Role): ethers.HDNodeWallet {
  const phrase = process.env.MNEMONIC;
  if (!phrase) {
    throw new Error("MNEMONIC is not set. Put it in .env (see .env.example); never commit that file.");
  }
  const w = ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${ROLE_INDEX[role]}`);
  return w.connect(provider());
}

export function address(role: Role): string {
  return wallet(role).address;
}

/**
 * Signer for SENDING transactions. Tracks nonces locally, because public RPCs
 * (and some nodes) can report a stale nonce right after a tx is mined, which
 * makes back-to-back sends fail with "nonce too low".
 */
const txSigners = new Map<Role, ethers.NonceManager>();
export function txSigner(role: Role): ethers.NonceManager {
  let s = txSigners.get(role);
  if (!s) {
    s = new ethers.NonceManager(wallet(role));
    txSigners.set(role, s);
  }
  return s;
}

export interface Deployment {
  escrow: string;
  chainId: number;
  deployedAt: string;
}

export function loadDeployment(): Deployment {
  if (!fs.existsSync(DEPLOYMENT_FILE)) {
    throw new Error("No deployment.json yet. Run `npm run deploy` first.");
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export function loadArtifact(): { abi: ethers.InterfaceAbi; bytecode: string } {
  if (!fs.existsSync(ARTIFACT_FILE)) {
    throw new Error("Contract not compiled. Run `npm run compile` first.");
  }
  return JSON.parse(fs.readFileSync(ARTIFACT_FILE, "utf8"));
}

export function escrowContract(runner: ethers.ContractRunner): ethers.Contract {
  const { abi } = loadArtifact();
  return new ethers.Contract(loadDeployment().escrow, abi, runner);
}

export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const fmt = (wei: bigint) => `${ethers.formatEther(wei)} XRP`;
