// Failure-only diagnostics. Do not change collection, execution or test verdicts.
export default class TestFailureReporter {
  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state !== 'failed') return;
    process.stderr.write(
      '[case-failure] ' +
        JSON.stringify({
          module: testCase.module.moduleId,
          test: testCase.fullName,
          errors: result.errors?.map((error) => ({
            name: error.name,
            message: error.message,
            stack: error.stack,
            startupEvidence: error.startupEvidence,
          })),
        }) +
        '\n',
    );
  }
}
