// MOCK home-inspection results standing in for a licensed inspector's report sections.
export const CHECK_TYPES = ["structure", "roof", "systems", "pests"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export function mockResult(type: CheckType, property: string, fail: boolean) {
  switch (type) {
    case "structure":
      return { ok: true, property, foundation: "no cracks beyond cosmetic", framing: "sound", findings: ["Foundation and framing in good condition"] };
    case "roof":
      return fail
        ? { ok: false, property, findings: ["Active leak above the upstairs bedroom", "Flashing failed around the chimney; repair est. $18,000"] }
        : { ok: true, property, findings: ["Roof about 6 years old, no leaks found", "Flashing and gutters in good condition"] };
    case "systems":
      return { ok: true, property, electrical: "200A panel, up to code", plumbing: "copper, no leaks", hvac: "serviced 2025", findings: ["Electrical, plumbing and HVAC all pass"] };
    case "pests":
      return { ok: true, property, findings: ["No termites or active infestation found"] };
  }
}
