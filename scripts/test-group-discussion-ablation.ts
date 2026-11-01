// Opt-in exploratory component experiment. No production file or DB mutation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discussionAblationArms } from './lib/discussion-ablation.js';

assert(
  process.env.MINICLAW_GROUP_MODEL_CONFIG,
  'Set the private model configuration path',
);
const output = process.env.MINICLAW_GROUP_ABLATION_EVIDENCE_PATH;
assert(output, 'Set a private ablation evidence path');
const limit = Number(process.env.MINICLAW_GROUP_ABLATION_MAX_REQUESTS ?? 96);
assert(Number.isInteger(limit) && limit > 0 && limit <= 300);
const report: any = {
  startedAt: new Date().toISOString(),
  scope:
    'Real Node/Pi component experiment with test-process-only source overlays; no rollout, deployed Cloudflare or physical phone claim',
  cases: ['natural', 'closed-pass'],
  repetitions: 2,
  order:
    'Forward arm order on repetition one; reversed on repetition two. Fresh Group/profile/native Session per case.',
  comparisons: [
    {
      axis: 'wire',
      baseline: 'wire-v1',
      treatment: 'wire-v2',
      held: 'coordinator scheduler and neutral output guidance; v2 context retains its schema fields',
    },
    {
      axis: 'prompt',
      baseline: 'wire-v2',
      treatment: 'natural-v2',
      held: 'v2 wire and coordinator scheduler',
    },
    {
      axis: 'scheduler',
      baseline: 'natural-v2',
      treatment: 'relay-v2',
      held: 'v2 wire and natural output guidance; treatment includes relay eligibility',
    },
  ],
  limitations:
    'Two exploratory chat-only controls, same private model/configuration and budgets. Not a complete factorial, blinded human study or model-independent quality proof. Delegation is excluded from every arm. Observed token counts include protocol/context shape differences.',
  jobs: [],
  actualProviderAttempts: 0,
  passed: false,
};
const write = () => {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(output, 0o600);
};
try {
  write();
  for (const repetition of [1, 2]) {
    const arms = Object.entries(discussionAblationArms);
    if (repetition === 2) arms.reverse();
    for (const [arm, setting] of arms) {
      const remaining = limit - report.actualProviderAttempts;
      if (remaining <= 0) throw new Error('ABLATION_REQUEST_LIMIT_EXHAUSTED');
      const file = output.replace(/\.json$/, '') + `-${repetition}-${arm}.json`;
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--use-env-proxy',
            '--import',
            'tsx',
            'scripts/test-group-discussion-compare.ts',
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              MINICLAW_GROUP_EVIDENCE_PATH: file,
              MINICLAW_GROUP_ABLATION_ARM: arm,
              MINICLAW_GROUP_POLICIES: setting.policy,
              MINICLAW_GROUP_CASES: 'natural,closed-pass',
              MINICLAW_GROUP_REPEATS: '1',
              MINICLAW_GROUP_MAX_REQUESTS: String(Math.min(18, remaining)),
              MINICLAW_GROUP_BROWSER: '0',
              MINICLAW_GROUP_RESTART: '0',
              MINICLAW_GROUP_POLICY_TRANSITION: '0',
            },
            stdio: ['ignore', 'ignore', 'ignore'],
          },
        );
        child.once('error', reject);
        child.once('exit', resolve);
      });
      let evidence: any;
      try {
        evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error('ABLATION_EVIDENCE_MISSING');
      }
      const actual = evidence.actualProviderAttempts ?? 0;
      report.actualProviderAttempts += actual;
      const versionsMatch =
        evidence.cases?.length === 2 &&
        evidence.cases.every(
          (c: any) =>
            c.policyVersion === setting.policy &&
            c.protocolVersion === setting.version,
        );
      const job = {
        repetition,
        arm,
        exitCode,
        reportFile: path.basename(file),
        reportSha256: createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex'),
        actualProviderAttempts: actual,
        correctnessPassed: evidence.correctnessPassed === true && versionsMatch,
        versionsMatch,
        syntheticRequests: evidence.syntheticRequests,
        cases: evidence.cases?.map((c: any) => ({
          case: c.case,
          status: c.status,
          passed: c.passed,
          modelAttempts: c.modelAttempts,
          firstVisibleReplyMs: c.firstVisibleReplyMs,
          metrics: c.metrics,
          quietPassWitnesses: c.quietPassWitnesses,
          publicMessages: c.publicMessages,
          cleanupConfirmed: c.cleanupConfirmed,
        })),
        experiment: evidence.ablationExperiment,
      };
      report.jobs.push(job);
      write();
      console.info(
        JSON.stringify({
          repetition,
          arm,
          correctnessPassed: job.correctnessPassed,
          providerAttempts: actual,
        }),
      );
    }
  }
  report.correctnessPassed =
    report.jobs.length === 8 &&
    report.jobs.every(
      (j: any) => j.correctnessPassed && j.syntheticRequests === 0,
    );
  report.qualityReviewPending = true;
  if (!report.correctnessPassed) process.exitCode = 1;
} catch {
  report.errorCode = 'ABLATION_INCOMPLETE';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  write();
}
