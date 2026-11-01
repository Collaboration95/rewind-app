import assert from 'node:assert/strict';
import test from 'node:test';
import coverageSummary from './coverage-summary-reporter.mjs';

test('server coverage JSON retains measured totals without labelling lines as statements', async () => {
  const events = [
    { type: 'test:pass' },
    {
      type: 'test:coverage',
      data: {
        summary: {
          totals: {
            totalLineCount: 10,
            coveredLineCount: 8,
            coveredLinePercent: 80,
            totalBranchCount: 4,
            coveredBranchCount: 1,
            coveredBranchPercent: 25,
            totalFunctionCount: 3,
            coveredFunctionCount: 2,
            coveredFunctionPercent: 66.67,
          },
        },
      },
    },
  ];
  const chunks = [];
  for await (const chunk of coverageSummary(events)) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  const { total } = JSON.parse(chunks[0]);
  assert.deepEqual(total.lines, { total: 10, covered: 8, skipped: 0, pct: 80 });
  assert.equal(total.branches.pct, 25);
  assert.equal(total.functions.pct, 66.67);
  assert.equal('statements' in total, false);
});
