// Offline tests for the contract reader (no chain, no AWS). Run: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDate, readContractText, validDate } from "../src/contract.js";

const NOW = new Date("2026-10-25T12:00:00Z");
const sample = (f: string) => fs.readFileSync(`sample-contracts/${f}`, "utf8");

// dates
assert.equal(parseDate("2026-10-20"), "2026-10-20");
assert.equal(parseDate("October 21, 2026"), "2026-10-21");
assert.equal(parseDate("Oct 3rd, 2026"), "2026-10-03");
assert.equal(parseDate("10/20/2026"), "2026-10-20");
assert.equal(parseDate("2026-02-30"), null);
assert.match(validDate("2026-12-31", NOW)!, /future/);
assert.match(validDate("1999-01-01", NOW)!, /old/);
assert.equal(validDate("2026-10-20", NOW), null);

// the three sample contracts
assert.deepEqual(readContractText(sample("purchase-contract-10pct.txt"), NOW), { ok: true, date: "2026-10-20", depositPct: 10, source: "text" });
assert.deepEqual(readContractText(sample("purchase-contract-20pct.txt"), NOW), { ok: true, date: "2026-10-21", depositPct: 20, source: "text" });
const bad = readContractText(sample("purchase-contract-unreadable.txt"), NOW);
assert.equal(bad.ok, false);

// failure modes: never guess
const base = "Contract Date: 2026-10-20\nThe buyer pays a deposit of 10% of the price into escrow.";
assert.equal(readContractText(base, NOW).ok, true);
assert.equal(readContractText(base.replace("10%", "15%"), NOW).ok, false);                       // unsupported percent
assert.equal(readContractText(base + "\nThe deposit is 20% of the price.", NOW).ok, false);       // conflicting percents
assert.equal(readContractText(base + "\nDated 2026-10-21", NOW).ok, false);                       // conflicting dates
assert.equal(readContractText(base.replace("2026-10-20", "2027-01-01"), NOW).ok, false);          // future date
assert.equal(readContractText("", NOW).ok, false);                                               // empty
assert.equal(readContractText("Contract Date: 2026-10-20\nNo money terms here at all, just words.", NOW).ok, false);

console.log("contract parser: all tests passed");
