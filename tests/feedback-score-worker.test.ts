import { afterEach, expect, test, vi } from 'vitest';

const f = vi.hoisted(() => ({
  privateClaim: vi.fn(),
  privateFinish: vi.fn(),
  groupClaim: vi.fn(),
  groupFinish: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../src/personal-agent/host-observability.js', () => ({
  getHostObservability: () => ({
    projectRef: 'project',
    sendFeedbackScore: f.send,
  }),
}));
vi.mock('../src/personal-agent/message-feedback.js', () => ({
  claimFeedbackScore: f.privateClaim,
  finishFeedbackScore: f.privateFinish,
}));
vi.mock('../src/bot-groups/store.js', () => ({
  claimGroupFeedbackScore: f.groupClaim,
  finishGroupFeedbackScore: f.groupFinish,
}));
const worker = await import('../src/personal-agent/feedback-score-export.js');
afterEach(async () => {
  await worker.stopFeedbackScoreExport();
  vi.clearAllMocks();
});

test('the bounded Host worker sends Group scores and persists uncertain delivery without treating it as private', async () => {
  const job = {
    feedback_id: 'group-feedback',
    project_ref: 'project',
    trace_id: 'a'.repeat(32),
    timestamp: '2026-10-28T00:00:00Z',
    score: 1,
    version: 2,
  };
  f.privateClaim.mockReturnValue(null);
  f.groupClaim.mockReturnValueOnce(job).mockReturnValue(null);
  f.send.mockResolvedValue('uncertain');
  worker.startFeedbackScoreExport();
  await vi.waitFor(() =>
    expect(f.groupFinish).toHaveBeenCalledWith(
      job.feedback_id,
      job.version,
      'uncertain',
    ),
  );
  expect(f.send).toHaveBeenCalledWith(job);
  expect(f.groupClaim).toHaveBeenCalledWith('project');
  expect(f.privateFinish).not.toHaveBeenCalled();
});
