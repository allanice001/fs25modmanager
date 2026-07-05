import { describe, it, expect } from "vitest";
import {
  Rule,
  Sample,
  compare,
  describeRule,
  evaluateRule,
  metricValue,
} from "./rules";

// day = month when daysPerPeriod = 1, which keeps the sustained math readable.
const s = (
  day: number,
  cash: number,
  debt: number,
  equipment = 0,
  vehicles = 0,
): Sample => ({
  day,
  daysPerPeriod: 1,
  cash,
  debt,
  equipment,
  vehicles,
});

describe("metricValue / compare", () => {
  it("derives net = cash + equipment - debt", () => {
    expect(metricValue(s(0, 500, 200, 100), "net")).toBe(400);
    expect(metricValue(s(0, 500, 200, 100), "debt")).toBe(200);
  });
  it("treats sub-dollar diffs as equal", () => {
    expect(compare(0.3, "eq", 0)).toBe(true);
    expect(compare(2, "eq", 0)).toBe(false);
    expect(compare(1_000_000, "gte", 1_000_000)).toBe(true);
  });
});

describe("describeRule", () => {
  it("phrases debt-free sustained nicely", () => {
    expect(
      describeRule({ id: "1", metric: "debt", op: "eq", value: 0, when: "sustained", months: 6 }),
    ).toBe("Debt-free for 6 months");
  });
  it("phrases a net-worth goal and never-bankrupt", () => {
    expect(
      describeRule({ id: "2", metric: "net", op: "gte", value: 1_000_000, when: "ever" }),
    ).toContain("Net worth ≥ $1,000,000");
    expect(
      describeRule({ id: "3", metric: "cash", op: "lt", value: 0, when: "never" }),
    ).toBe("Never cash < $0");
  });
});

describe("evaluateRule", () => {
  const debtFree6: Rule = {
    id: "df",
    metric: "debt",
    op: "eq",
    value: 0,
    when: "sustained",
    months: 6,
  };

  it("is unknown with no history", () => {
    expect(evaluateRule(debtFree6, []).state).toBe("unknown");
  });

  it("passes debt-free for 6 consecutive months", () => {
    const h = [0, 1, 2, 3, 4, 5, 6].map((d) => s(d, 100, 0));
    const r = evaluateRule(debtFree6, h);
    expect(r.state).toBe("pass");
    expect(r.progress).toBe(1);
  });

  it("resets the clock on a debt spike (consecutive)", () => {
    // clean 0..3, debt at 4, clean 5..8 -> best run is 3 months, not 6
    const h = [
      s(0, 100, 0),
      s(1, 100, 0),
      s(2, 100, 0),
      s(3, 100, 0),
      s(4, 100, 50),
      s(5, 100, 0),
      s(6, 100, 0),
      s(7, 100, 0),
      s(8, 100, 0),
    ];
    const r = evaluateRule(debtFree6, h);
    expect(r.state).toBe("pending");
    expect(r.detail).toContain("3.0/6");
  });

  it("counts cumulative months when consecutive is false", () => {
    const h = [
      s(0, 100, 0),
      s(1, 100, 0),
      s(2, 100, 0),
      s(3, 100, 0),
      s(4, 100, 50),
      s(5, 100, 0),
      s(6, 100, 0),
      s(7, 100, 0),
      s(8, 100, 0),
    ];
    const r = evaluateRule({ ...debtFree6, consecutive: false }, h);
    expect(r.state).toBe("pass"); // 3 + 3 = 6 cumulative
  });

  it("now/ever/always/never use the whole history correctly", () => {
    const h = [s(0, 100, 0), s(1, 100, 50), s(2, 100, 0)];
    const debtFreeNow: Rule = { id: "n", metric: "debt", op: "eq", value: 0, when: "now" };
    expect(evaluateRule(debtFreeNow, h).state).toBe("pass"); // last sample debt 0

    const alwaysDebtFree: Rule = { id: "a", metric: "debt", op: "eq", value: 0, when: "always" };
    expect(evaluateRule(alwaysDebtFree, h).state).toBe("fail"); // day 1 had debt

    const everMillion: Rule = { id: "e", metric: "cash", op: "gte", value: 1000, when: "ever" };
    expect(evaluateRule(everMillion, h).state).toBe("pending"); // never hit 1000

    const neverBankrupt: Rule = { id: "b", metric: "cash", op: "lt", value: 0, when: "never" };
    expect(evaluateRule(neverBankrupt, h).state).toBe("pass"); // never below 0
  });
});
