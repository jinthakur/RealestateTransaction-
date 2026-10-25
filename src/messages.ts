// Plain-language messages in "From -> To" format. One source for BOTH the dashboard
// balloons and the emails, so they always say the same thing.
export type Party = "Buyer" | "Seller" | "Attorney" | "Inspector" | "Agent";

export interface DealEvent {
  name: "DealOpened" | "InspectionRecorded" | "WalkthroughRecorded" | "BuyerApproved" | "SellerApproved" | "DealClosed" | "DealCancelled";
  dealId: string;
  property?: string;
  price?: string;     // formatted, e.g. "5.0 XRP"
  deposit?: string;
  depositPct?: number; // 10 or 20, from the signed contract
  amount?: string;
  passed?: boolean;
  evidence?: string;  // inspection evidence or walkthrough notes
  reason?: string;
  otherOk?: boolean;  // for approvals: had the other party already approved?
}

export interface PartyMessage {
  from: Party;
  to: Party;
  subject: string;   // e.g. "Seller to Attorney message"
  headline: string;
  text: string;
  tone: "info" | "good" | "bad";
}

export const subjectFor = (from: Party, to: Party) => `${from} to ${to} message`;

export const msg = (from: Party, to: Party, headline: string, text: string, tone: PartyMessage["tone"] = "info"): PartyMessage =>
  ({ from, to, subject: subjectFor(from, to), headline, text, tone });

export function messagesFor(e: DealEvent): PartyMessage[] {
  const home = e.property ? ` for ${e.property}` : "";
  switch (e.name) {
    case "DealOpened":
      return [
        msg("Buyer", "Attorney", "Deposit sent to your escrow",
          `I signed the contract${home} at ${e.price} and sent my ${e.depositPct ?? 10}% deposit of ${e.deposit} to your escrow account. Please hold it until the inspection, my final walkthrough and both approvals are done.`),
        msg("Attorney", "Buyer", "Deposit received - receipt",
          `Your ${e.depositPct ?? 10}% deposit of ${e.deposit} (home price ${e.price}) is now in my escrow account${home}. The seller cannot touch it yet. If the inspection or walkthrough fails, I return it to you in full.`),
        msg("Attorney", "Seller", "Buyer's deposit is in escrow",
          `The buyer signed${home} at ${e.price} and ${e.deposit} (${e.depositPct ?? 10}%) is now held in my escrow account. You are paid when the inspection passes, the buyer's final walkthrough passes, and you and the buyer both approve.`),
      ];
    case "InspectionRecorded":
      return e.passed
        ? [
          msg("Agent", "Buyer", "Home inspection PASSED",
            `I checked the inspector's report and the independent checks: everything passed. Next step for you: do the final walkthrough of the home, then approve closing.`, "good"),
          msg("Agent", "Seller", "Home inspection PASSED",
            `The home inspection passed. The buyer will now do the final walkthrough. After that, please approve closing; you are paid when you and the buyer have both approved.`, "good"),
          msg("Agent", "Attorney", "Home inspection PASSED",
            `Inspection passed and recorded on-chain. Keep the deposit in escrow until the buyer's final walkthrough passes and the buyer and seller both approve.`, "good"),
        ]
        : [
          msg("Agent", "Buyer", "Home inspection FAILED",
            `The home inspection did not pass (${e.evidence || "see report"}). Your deposit is safe in escrow and the attorney will return it to you.`, "bad"),
          msg("Agent", "Seller", "Home inspection FAILED",
            `The home inspection did not pass (${e.evidence || "see report"}). The deal cannot close and the deposit goes back to the buyer.`, "bad"),
          msg("Agent", "Attorney", "Inspection FAILED - action needed",
            `The inspection failed (${e.evidence || "see report"}). Please cancel the deal to return the ${e.deposit ?? "deposit"} to the buyer.`, "bad"),
        ];
    case "WalkthroughRecorded":
      return e.passed
        ? [
          msg("Buyer", "Seller", "Final walkthrough done - I'm satisfied",
            `I completed the final walkthrough${home} and the home is as agreed. I will approve closing now; please approve too.`, "good"),
          msg("Buyer", "Attorney", "Final walkthrough passed",
            `My final walkthrough passed. Release the deposit as soon as the seller and I have both approved.`, "good"),
        ]
        : [
          msg("Buyer", "Attorney", "Final walkthrough found a problem - please cancel",
            `I found a problem on the final walkthrough (${e.evidence || "see notes"}). Please cancel the deal and return my ${e.deposit ?? "deposit"}.`, "bad"),
          msg("Buyer", "Seller", "Final walkthrough found a problem",
            `I found a problem on the final walkthrough (${e.evidence || "see notes"}), so I cannot proceed to closing.`, "bad"),
        ];
    case "BuyerApproved": {
      const both = Boolean(e.otherOk);
      return [
        msg("Buyer", "Seller", "I approve closing",
          both ? "I approve closing. You already approved, so the deal is closing now." : "I approve closing. Please approve now so the deposit is released to you.", both ? "good" : "info"),
        msg("Buyer", "Attorney", "Buyer approved",
          both ? "I approve release. The seller already approved, so the escrow can pay out now." : "I approve release of the deposit. Still waiting for the seller."),
      ];
    }
    case "SellerApproved": {
      const both = Boolean(e.otherOk);
      return [
        msg("Seller", "Buyer", "I approve closing",
          both ? "I approve closing. You already approved, so the deal is closing now." : "I approve closing. Please approve too so the deal can close.", both ? "good" : "info"),
        msg("Seller", "Attorney", "Seller approved",
          both ? "I approve release. The buyer already approved, so the escrow can pay out now." : "I approve release of the deposit. Still waiting for the buyer."),
      ];
    }
    case "DealClosed":
      return [
        msg("Attorney", "Seller", "DEAL CLOSED - you were paid", `The deal is closed${home}. I released ${e.amount} from escrow to you.`, "good"),
        msg("Attorney", "Buyer", "DEAL CLOSED", `The deal is closed${home}. Your ${e.amount} deposit was paid to the seller. Congratulations on your new home!`, "good"),
        msg("Seller", "Attorney", "Payment received", `I confirm I received ${e.amount} from your escrow${home}. Thank you - the file is complete.`, "good"),
      ];
    case "DealCancelled":
      return [
        msg("Attorney", "Buyer", "Deal cancelled - deposit returned", `The deal was cancelled (${e.reason}). Your ${e.amount} deposit has been returned to you in full.`, "bad"),
        msg("Attorney", "Seller", "Deal cancelled", `The deal${home} was cancelled (${e.reason}). The deposit went back to the buyer.`, "bad"),
      ];
  }
}
