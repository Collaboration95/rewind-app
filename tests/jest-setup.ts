// Legacy shell integration tests start from an explicitly synthetic Demo
// fixture. Entry-flow tests turn this off and exercise first-run behavior.
process.env.REWIND_TEST_DEMO_FIXTURE = 'true';
