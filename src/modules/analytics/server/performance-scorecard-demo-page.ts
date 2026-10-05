import { nameOrder, scorecardPeriodOptions, type ScorecardFilters, type ScorecardFund } from "../domain/performance-scorecard.ts";
import { demoPerformanceScorecard } from "./performance-scorecard-demo.ts";
import { fundsAfterCursor, nextFundCursor, scorecardPageSize, type ScorecardPageRequest, type ScorecardPageResult } from "./performance-scorecard.ts";

function inScorecardOrder(funds: readonly ScorecardFund[]): ScorecardFund[] {
  return [...funds].sort((a, b) => nameOrder({ name: a.fund, id: a.fundId }, { name: b.fund, id: b.fundId }));
}

/**
 * One keyset page of the demo scorecard, built the way the Postgres read pages it: whole funds in scorecard order, the
 * filters applied before the page is cut, every entitled fund offered as a fund option and the periods of every figure
 * offered when asked for. Kept apart from the demo dataset so the browser bundle that reads the dataset (demo delivery)
 * never pulls in the server's paging and database modules.
 */
export function demoScorecardPage(filters: ScorecardFilters, request: ScorecardPageRequest = {}): ScorecardPageResult {
  const everything = demoPerformanceScorecard();
  const narrowed = demoPerformanceScorecard(filters);
  const remaining = fundsAfterCursor(inScorecardOrder(narrowed.funds), request.cursor);
  const funds = remaining.slice(0, scorecardPageSize(request.limit));
  const pageIds = new Set(funds.map((fund) => fund.fundId));
  return {
    payload: { funds, facts: narrowed.facts.filter((fact) => pageIds.has(fact.fundId)) },
    fundOptions: inScorecardOrder(everything.funds),
    periodOptions: request.periods ? scorecardPeriodOptions(everything.facts) : [],
    nextCursor: nextFundCursor(funds, remaining.length),
  };
}
