import { describe, expect, it } from "vitest";
import { alternatives, bestOption } from "../src/apply/match-option";

describe("matching an answer to a site's option", () => {
  it("handles demonyms, synonyms, case and degree names", () => {
    expect(bestOption("Egyptian", ["Egypt", "Eritrea", "Estonia"])).toBe("Egypt");
    expect(bestOption("Islam", ["Christian", "Muslim", "Other"])).toBe("Muslim");
    expect(bestOption("married", ["Single", "Married", "Divorced"])).toBe("Married");
    expect(bestOption("Saudi", ["Saudi Arabia", "Sudan"])).toBe("Saudi Arabia");
    expect(bestOption("Bachelor", ["Diploma", "Bachelor's Degree", "Master's Degree"])).toBe("Bachelor's Degree");
    expect(bestOption("Iqama", ["Passport", "Iqama", "National ID"])).toBe("Iqama");
    expect(bestOption("Egyptian", ["Egyptian"])).toBe("Egyptian");
  });
  it("refuses to guess when it isn't clear", () => {
    expect(bestOption("Engineer", ["Engineering", "Engineering Manager"])).toBeNull();
    expect(bestOption("Islam", ["A", "B"])).toBeNull();
    expect(alternatives("Egyptian")).toContain("egypt");
  });
});
