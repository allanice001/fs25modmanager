// Scenario rule engine. Rules are conditions over a time series of savegame
// samples (fed by the companion mod's telemetry and/or save snapshots), so they
// can express sustained/duration conditions like "debt-free for 6 months", not
// just an instantaneous snapshot check.

export type Metric = "cash" | "debt" | "net" | "equipment";
export type Op = "gte" | "lte" | "gt" | "lt" | "eq" | "neq";
/** Temporal quantifier for the condition. */
export type When = "now" | "ever" | "always" | "never" | "sustained";

export interface Rule {
  id: string;
  metric: Metric;
  op: Op;
  value: number;
  when: When;
  /** For `sustained`: required duration in in-game months. */
  months?: number;
  /** For `sustained`: true = consecutive (clock resets on a break); false =
   *  cumulative total. Default true. */
  consecutive?: boolean;
  /** Optional label override; otherwise describeRule() is used. */
  label?: string;
}

/** One point in a scenario's history (one in-game day). */
export interface Sample {
  /** Monotonic in-game day — the time axis. */
  day: number;
  /** Days per in-game period (month), to convert day spans → months. */
  daysPerPeriod: number;
  cash: number;
  debt: number;
  /** Owned-equipment (vehicle) value. */
  equipment: number;
}

export type RuleState = "pass" | "fail" | "pending" | "unknown";

export interface RuleStatus {
  state: RuleState;
  /** 0..1 toward satisfying, when meaningful (sustained duration). */
  progress?: number;
  detail: string;
}

const EPS = 0.5; // money is float; treat sub-dollar diffs as equal

export function metricValue(s: Sample, m: Metric): number {
  switch (m) {
    case "cash":
      return s.cash;
    case "debt":
      return s.debt;
    case "equipment":
      return s.equipment;
    case "net":
      return s.cash + s.equipment - s.debt;
  }
}

export function compare(a: number, op: Op, b: number): boolean {
  switch (op) {
    case "gte":
      return a >= b - EPS;
    case "lte":
      return a <= b + EPS;
    case "gt":
      return a > b + EPS;
    case "lt":
      return a < b - EPS;
    case "eq":
      return Math.abs(a - b) <= EPS;
    case "neq":
      return Math.abs(a - b) > EPS;
  }
}

const METRIC_LABEL: Record<Metric, string> = {
  cash: "cash",
  debt: "debt",
  net: "net worth",
  equipment: "equipment",
};
const OP_LABEL: Record<Op, string> = {
  gte: "≥",
  lte: "≤",
  gt: ">",
  lt: "<",
  eq: "=",
  neq: "≠",
};

const fmtMoney = (n: number) => "$" + Math.round(n).toLocaleString();

/** Human-readable description, e.g. "Debt-free for 6 months". */
export function describeRule(r: Rule): string {
  if (r.label) return r.label;

  // Nice phrasings for the common debt conditions.
  let cond: string;
  if (r.metric === "debt" && r.op === "eq" && Math.abs(r.value) <= EPS) {
    cond = "Debt-free";
  } else if (r.metric === "debt" && (r.op === "gt" || r.op === "gte") && r.value <= EPS) {
    cond = "Carrying debt";
  } else {
    cond = `${METRIC_LABEL[r.metric]} ${OP_LABEL[r.op]} ${fmtMoney(r.value)}`;
    cond = cond.charAt(0).toUpperCase() + cond.slice(1);
  }

  switch (r.when) {
    case "now":
      return cond;
    case "ever":
      return `${cond} at some point`;
    case "always":
      return `${cond} at all times`;
    case "never":
      return `Never ${cond.toLowerCase()}`;
    case "sustained": {
      const m = r.months ?? 0;
      return `${cond} for ${m} month${m === 1 ? "" : "s"}${r.consecutive === false ? " (total)" : ""}`;
    }
  }
}

/** Longest consecutive (or cumulative) span, in months, over which `sat` holds,
 *  measured by in-game day spans. */
function satisfiedMonths(
  history: Sample[],
  sat: (s: Sample) => boolean,
  consecutive: boolean,
): number {
  const dpp = history[history.length - 1]?.daysPerPeriod || 1;
  let best = 0;
  let cumulativeDays = 0;
  let runStart: number | null = null;
  let prevSatisfied: number | null = null;
  for (const s of history) {
    if (sat(s)) {
      if (runStart === null) runStart = s.day;
      best = Math.max(best, s.day - runStart);
      prevSatisfied = s.day;
    } else {
      if (runStart !== null && prevSatisfied !== null) {
        cumulativeDays += prevSatisfied - runStart;
      }
      runStart = null;
      prevSatisfied = null;
    }
  }
  if (runStart !== null && prevSatisfied !== null) {
    cumulativeDays += prevSatisfied - runStart;
  }
  const days = consecutive ? best : cumulativeDays;
  return days / dpp;
}

/** Evaluate a rule against a scenario's day-ordered history. */
export function evaluateRule(rule: Rule, history: Sample[]): RuleStatus {
  const sorted = [...history].sort((a, b) => a.day - b.day);
  if (sorted.length === 0) {
    return { state: "unknown", detail: "no data yet" };
  }
  const sat = (s: Sample) => compare(metricValue(s, rule.metric), rule.op, rule.value);
  const desc = describeRule(rule);

  switch (rule.when) {
    case "now": {
      const ok = sat(sorted[sorted.length - 1]);
      return { state: ok ? "pass" : "fail", detail: desc };
    }
    case "ever": {
      const ok = sorted.some(sat);
      return { state: ok ? "pass" : "pending", detail: desc };
    }
    case "always": {
      const ok = sorted.every(sat);
      return { state: ok ? "pass" : "fail", detail: desc };
    }
    case "never": {
      const broken = sorted.some(sat);
      return { state: broken ? "fail" : "pass", detail: desc };
    }
    case "sustained": {
      const target = rule.months ?? 0;
      const achieved = satisfiedMonths(sorted, sat, rule.consecutive !== false);
      const progress = target > 0 ? Math.min(1, achieved / target) : 1;
      const state: RuleState = achieved + 1e-6 >= target ? "pass" : "pending";
      return {
        state,
        progress,
        detail: `${desc} — ${achieved.toFixed(1)}/${target} months`,
      };
    }
  }
}
