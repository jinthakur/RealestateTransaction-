declare module "*.cjs" { const sdk: any; export default sdk; }
declare module "*/ap4m-x402.mjs" {
  export const loadX402Context: (apiUrl: string) => Promise<any>;
  export const buyResource: (o: any) => Promise<{ operation: string; claimId: string; transactionHash: string; redemption: string; resource: unknown }>;
  export const createX402Merchant: (c: any) => { server: import("node:http").Server; close: () => Promise<void> };
}
