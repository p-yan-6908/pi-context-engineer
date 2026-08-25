import { explainProgram, formatProgramExplanation } from "./explanation.js";
import type { ProgramExplanation } from "./explanation.js";
import type { ResolvedBound } from "./context-effects.js";

interface ExplanationCase {
  name: string;
  program: string;
  classification: ProgramExplanation["classification"];
  bounded: boolean;
  bound: ResolvedBound;
  effects: string[];
}

const cases: readonly ExplanationCase[] = [
  {
    name: "raw source",
    program: `return pi.read({ path: "x" });`,
    classification: "unsafe",
    bounded: false,
    bound: { kind: "unknown" },
    effects: ["source"],
  },
  {
    name: "source to scalar",
    program: `const raw = await pi.read({ path: "x" }); return raw.length;`,
    classification: "safe",
    bounded: true,
    bound: { kind: "unknown" },
    effects: ["source", "scalar"],
  },
  {
    name: "literal select",
    program: `return extensions.ctx_read({ id: "h", length: 4096 });`,
    classification: "safe",
    bounded: true,
    bound: { kind: "exact", value: 4096, unit: "bytes" },
    effects: ["select"],
  },
  {
    name: "unknown select bound",
    program: `return extensions.ctx_read({ id: "h", length: n });`,
    classification: "safe",
    bounded: true,
    bound: { kind: "unknown", unit: "bytes" },
    effects: ["select"],
  },
  {
    name: "literal compression",
    program: `return extensions.ctx_summarize({ text: "x", maxTokens: 300 });`,
    classification: "safe",
    bounded: true,
    bound: { kind: "exact", value: 300, unit: "tokens" },
    effects: ["compress"],
  },
  {
    name: "select then compress",
    program: `const raw = await pi.read({path:"x"}); const page = await extensions.ctx_read({id:raw,length:4096}); return extensions.ctx_summarize({text:page,maxTokens:300});`,
    classification: "safe",
    bounded: true,
    bound: { kind: "exact", value: 300, unit: "tokens" },
    effects: ["source", "select", "compress"],
  },
  {
    name: "offload",
    program: `return extensions.ctx_offload({key:"x",source:"read",data:pi.read({path:"x"})});`,
    classification: "safe",
    bounded: true,
    bound: { kind: "unknown" },
    effects: ["source", "offload"],
  },
  {
    name: "unknown generic transformation",
    program: `const raw = await pi.read({ path: "x" }); return raw.replace("a", "b");`,
    classification: "unsafe",
    bounded: false,
    bound: { kind: "unknown" },
    effects: ["source"],
  },
  {
    name: "multiple independent values",
    program: `const a = await pi.read({path:"a"}); const b = await pi.read({path:"b"}); return { a, b };`,
    classification: "unsafe",
    bounded: false,
    bound: { kind: "unknown" },
    effects: ["source", "source"],
  },
];

const chainSnapshot = `Context analysis

pi.read
  SOURCE · unbounded · bound unknown
    ↓
extensions.ctx_read
  SELECT · ≤ 4096 bytes
    ↓
extensions.ctx_summarize
  COMPRESS · ≤ 300 tokens
    ↓
return
  BOUNDARY · ≤ 300 tokens`;

export interface ExplanationCheckResult {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExplanationChecks(): ExplanationCheckResult {
  const failures: string[] = [];
  const check = (name: string, condition: boolean): void => {
    if (!condition) failures.push(name);
  };
  for (const test of cases) {
    const explanation = explainProgram(test.program);
    const effects = explanation.provenance.map((step) => step.effect);
    check(`${test.name}: classification`, explanation.classification === test.classification);
    check(`${test.name}: boundedness`, explanation.bounded === test.bounded);
    check(`${test.name}: bound`, JSON.stringify(explanation.returnBound) === JSON.stringify(test.bound));
    check(`${test.name}: effects`, JSON.stringify(effects) === JSON.stringify(test.effects));
    check(`${test.name}: reasons`, explanation.provenance.every((step) => typeof step.reason === "string" && step.reason.length > 0));
    check(`${test.name}: locations`, explanation.provenance.every((step) => !step.location || (step.location.line >= 1 && step.location.column >= 1)));
    check(`${test.name}: deterministic`, JSON.stringify(explanation) === JSON.stringify(explainProgram(test.program)));
    check(`${test.name}: summary`, explanation.summary.startsWith(test.classification === "safe" ? "Safe return:" : "Unsafe return:"));
  }
  const chain = explainProgram(cases[5].program);
  check("formatter snapshot", formatProgramExplanation(chain) === chainSnapshot);
  const bytes = explainProgram(`return extensions.ctx_read({id:"h",length:4096});`).returnBound;
  const tokens = explainProgram(`return extensions.ctx_summarize({text:"x",maxTokens:4096});`).returnBound;
  check("formatter/unit separation", JSON.stringify(bytes) !== JSON.stringify(tokens));
  return { passed: cases.length * 8 + 2 - failures.length, failed: failures.length, failures };
}
