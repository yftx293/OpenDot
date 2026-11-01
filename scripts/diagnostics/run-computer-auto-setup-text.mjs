// Only creates and operates on the synthetic fixture; no screen capture.
import { runSyntheticFixtureText } from './synthetic-fixture-text.mjs';

await runSyntheticFixtureText({
  testFile: 'tests/computer-auto-setup-product-live.test.ts',
  failureMessage: 'KimiCU setup product test failed',
});
