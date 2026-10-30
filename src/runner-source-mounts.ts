import path from 'node:path';

/** Release containers run the source/prompts shipped together in their image.
 * A developer can explicitly opt into a matching pair of read-only overlays. */
export function runnerSourceMounts(
  projectRoot: string,
  enabled = process.env.MINICLAW_CONTAINER_LIVE_SOURCE === 'true',
): { hostPath: string; containerPath: string; readonly: boolean }[] {
  if (!enabled) return [];
  return ['src', 'prompts'].map((directory) => ({
    hostPath: path.join(projectRoot, 'container', 'agent-runner', directory),
    containerPath: '/app/' + directory,
    readonly: true,
  }));
}
