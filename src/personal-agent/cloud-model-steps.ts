/** Cloud sessions are billed per model step. 24 remains the default; operators can raise it. */
export const CLOUD_MODEL_STEP_CEILING = 64;
export const DEFAULT_CLOUD_MODEL_STEPS = 24;

export function cloudModelStepLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env.MINICLAW_CLOUD_MAX_MODEL_STEPS);
  if (
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= CLOUD_MODEL_STEP_CEILING
  )
    return parsed;
  return DEFAULT_CLOUD_MODEL_STEPS;
}
