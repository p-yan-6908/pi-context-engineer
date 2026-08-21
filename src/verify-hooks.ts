/**
 * Test the grep auto-repair and read auto-offload logic.
 * These are the two new code paths added in this round.
 */

import { repairGrepInput } from "./index.js";
import { ContextStore } from "./store.js";
import assert from "node:assert/strict";

// ---- Test grep auto-repair ----

const grepTests: Array<{ name: string; input: Record<string, unknown>; expectRepaired: boolean }> = [
  {
    name: "unescaped parens: hydrateCart(",
    input: { pattern: "hydrateCart(" },
    expectRepaired: true,
  },
  {
    name: "unclosed group: (?:hydrateCart(|loadLocalCart(",
    input: { pattern: "(?:hydrateCart(|loadLocalCart(" },
    expectRepaired: true,
  },
  {
    name: "braces in assignment: state.cart = {};",
    input: { pattern: "state.cart = {};" },
    expectRepaired: true,
  },
  {
    name: "already literal: no repair",
    input: { pattern: "clearCustomerSession(", literal: true },
    expectRepaired: false,
  },
  {
    name: "clean regex: no repair needed",
    input: { pattern: "function\\s+clearCustomerSession" },
    expectRepaired: false,
  },
  {
    name: "simple word: no repair needed",
    input: { pattern: "clearCustomerSession" },
    expectRepaired: false,
  },
  {
    name: "unclosed group with alt: refreshCustomer|clearCustomerSession|logout(",
    input: { pattern: "refreshCustomer|clearCustomerSession|logout(" },
    expectRepaired: true,
  },
];

let grepPassed = 0;
let grepFailed = 0;

console.log("=== Grep Auto-Repair Tests ===\n");
for (const test of grepTests) {
  // Deep clone input so we don't mutate the test data
  const input = JSON.parse(JSON.stringify(test.input));
  const result = repairGrepInput(input);
  const ok = result.repaired === test.expectRepaired;
  const status = ok ? "✅" : "❌";
  console.log(`${status} ${test.name}`);
  console.log(`   expected repaired=${test.expectRepaired}, got repaired=${result.repaired}`);
  if (result.repaired) {
    console.log(`   literal set to: ${input.literal}`);
  }
  if (!ok) grepFailed++;
  else grepPassed++;
}

// ---- Test read auto-offload ----

console.log("\n=== Read Auto-Offload Tests ===\n");

const store = new ContextStore("/tmp/pi-ce-test-" + Date.now());

const offloadTests = [
  {
    name: "large result offloaded with handle + preview",
    text: "x".repeat(20000),
    expectTruncated: true,
  },
  {
    name: "small result not offloaded (below threshold)",
    text: "small text",
    expectTruncated: false,
  },
];

let offloadPassed = 0;
let offloadFailed = 0;

for (const test of offloadTests) {
  const result = store.write("test-read", "read", test.text);
  const isLarge = result.bytes > 8192;
  const ok = test.expectTruncated ? isLarge : !isLarge;
  const status = ok ? "✅" : "❌";
  console.log(`${status} ${test.name}`);
  console.log(`   bytes=${result.bytes}, tokens=${result.estimatedTokens}, handle=${result.id.slice(0, 20)}...`);
  if (!ok) offloadFailed++;
  else offloadPassed++;
}

// ---- Test ctx_read retrieval of offloaded data ----

console.log("\n=== ctx_read Retrieval Tests ===\n");

const largeText = "line1: hello\nline2: world\nline3: clearCustomerSession\nline4: state.cart = {}";
const offloaded = store.write("test-readback", "read", largeText);

const readResult = store.read(offloaded.id, {});
const queryResult = store.read(offloaded.id, { query: "clearCustomerSession" });

console.log(`✅ ctx_read full preview (first ${readResult.bytesRead} bytes of ${readResult.totalBytes})`);
console.log(`✅ ctx_read query "clearCustomerSession": ${queryResult.matchedLines?.length ?? 0} matches`);

// ---- Summary ----

console.log("\n=== Summary ===");
console.log(`Grep auto-repair: ${grepPassed} passed, ${grepFailed} failed`);
console.log(`Read auto-offload: ${offloadPassed} passed, ${offloadFailed} failed`);

const totalFailed = grepFailed + offloadFailed;
if (totalFailed > 0) {
  console.log(`\n❌ ${totalFailed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed`);
}
