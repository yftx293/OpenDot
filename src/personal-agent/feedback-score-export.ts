import { getHostObservability } from './host-observability.js';
import { claimFeedbackScore, finishFeedbackScore } from './message-feedback.js';
import {
  claimGroupFeedbackScore,
  finishGroupFeedbackScore,
} from '../bot-groups/store.js';

let active = false;
let timer: ReturnType<typeof setInterval> | undefined;
let work: Promise<void> | undefined;

/** One bounded Host worker, no raw feedback or credentials in its queue. */
export function wakeFeedbackScoreExport() {
  if (!active || work) return;
  const observer = getHostObservability();
  if (!observer) return;
  let job;
  let groupJob = false;
  try {
    job = claimFeedbackScore(observer.projectRef);
    if (!job) {
      job = claimGroupFeedbackScore(observer.projectRef);
      groupJob = !!job;
    }
  } catch {
    return;
  }
  if (!job) return;
  work = (async () => {
    const result = await observer.sendFeedbackScore(job);
    try {
      if (groupJob)
        finishGroupFeedbackScore(job.feedback_id, job.version, result);
      else finishFeedbackScore(job.feedback_id, job.version, result);
    } catch {
      /* Local feedback stays intact. */
    }
  })().finally(() => {
    work = undefined;
    if (active) queueMicrotask(wakeFeedbackScoreExport);
  });
}
export function startFeedbackScoreExport() {
  if (active) return;
  active = true;
  timer = setInterval(wakeFeedbackScoreExport, 10_000);
  timer.unref?.();
  wakeFeedbackScoreExport();
}
export async function stopFeedbackScoreExport() {
  active = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  if (work)
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 3000);
        deadline.unref?.();
      }),
    ]);
}
