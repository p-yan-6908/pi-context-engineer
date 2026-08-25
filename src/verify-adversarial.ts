import { analyzeProgram } from "./analyzer.js";
import { buildAdversarialCases } from "./adversarial.js";

const cases = buildAdversarialCases();
let failures = 0;
const byFamily = new Map<string, { passed: number; failed: number }>();

for (const test of cases) {
  const result = analyzeProgram(test.program);
  const tier = result.hardBlock ? "BLOCK" : result.ok ? "PASS" : "WARN";
  const matched = tier === test.expectation;
  const stats = byFamily.get(test.family) ?? { passed: 0, failed: 0 };
  if (matched) stats.passed++;
  else stats.failed++;
  byFamily.set(test.family, stats);
  if (!matched) {
    failures++;
    console.log(`[FAIL] ${test.name}: expected ${test.expectation}, got ${tier}`);
    console.log(`       operation=${result.metrics.returnOperation}; taint=${result.metrics.returnTaint}; reasons=${result.reasons.join("; ")}`);
  }
}

for (const [family, stats] of byFamily) {
  console.log(`[${stats.failed === 0 ? "ok" : "FAIL"}] ${family}: ${stats.passed} passed, ${stats.failed} failed`);
}
console.log(`Adversarial analyzer suite: ${cases.length - failures} passed, ${failures} failed out of ${cases.length}`);
process.exitCode = failures === 0 ? 0 : 1;
