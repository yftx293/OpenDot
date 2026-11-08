import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  fixtureDigest,
  fixtureFiles,
  suites,
  summarize,
} from '../scripts/evaluation/cases.mjs';

test('an evaluation passes only when every named critical assertion actually passes', () => {
  const suite = suites[0];
  const report = {
    success: true,
    numPassedTests: suite.required.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        assertionResults: suite.required.map((title) => ({
          title,
          status: 'passed',
        })),
      },
    ],
  };
  expect(summarize(suite, report, 0).status).toBe('passed');
  expect(summarize(suite, { ...report, numPassedTests: 0 }, 0).status).toBe(
    'failed',
  );
  expect(
    summarize(suite, { ...report, testResults: [{ assertionResults: [] }] }, 0)
      .status,
  ).toBe('failed');
  expect(
    summarize(
      suite,
      {
        ...report,
        testResults: [
          {
            assertionResults: report.testResults[0].assertionResults.map(
              (a, i) => (i === 0 ? { ...a, status: 'pending' } : a),
            ),
          },
        ],
      },
      0,
    ).status,
  ).toBe('failed');
  expect(
    summarize(
      suite,
      {
        ...report,
        testResults: [
          {
            assertionResults: [
              ...report.testResults[0].assertionResults,
              report.testResults[0].assertionResults[0],
            ],
          },
        ],
      },
      0,
    ).status,
  ).toBe('failed');
  expect(summarize(suite, report, 1).status).toBe('failed');
  expect(summarize(suite, report, 0, true).status).toBe('failed');
  expect(summarize(suite, null, null).status).toBe('failed');
});

test('the declared fixture digest changes when a selected fixture changes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-digest-'));
  try {
    for (const file of fixtureFiles) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `fixture ${file}`);
    }
    const first = fixtureDigest(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(path.join(root, fixtureFiles[0]), 'changed');
    expect(fixtureDigest(root)).not.toBe(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
