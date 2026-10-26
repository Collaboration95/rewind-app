// node:test coverage totals, retained separately from the human and JUnit reporters.
export default async function* coverageSummary(source) {
  for await (const event of source) {
    if (event.type !== 'test:coverage') continue;
    const totals = event.data.summary.totals;
    const metric = (total, covered, pct) => ({
      total,
      covered,
      skipped: 0,
      pct: Math.round(pct * 100) / 100,
    });
    yield `${JSON.stringify({
      total: {
        lines: metric(totals.totalLineCount, totals.coveredLineCount, totals.coveredLinePercent),
        branches: metric(
          totals.totalBranchCount,
          totals.coveredBranchCount,
          totals.coveredBranchPercent,
        ),
        functions: metric(
          totals.totalFunctionCount,
          totals.coveredFunctionCount,
          totals.coveredFunctionPercent,
        ),
      },
    })}\n`;
  }
}
