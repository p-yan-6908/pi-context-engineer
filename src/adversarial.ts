/** Generated adversarial transformations for the analyzer's taint invariants. */

export type AdversarialExpectation = "BLOCK" | "PASS";

export interface AdversarialCase {
  name: string;
  family: string;
  expectation: AdversarialExpectation;
  program: string;
}

const unsafeSource = `const raw = await pi.read({ path: "large.txt" });`;
const safeSource = `const raw = await pi.read({ path: "large.txt" });`;

const unsafeBodies: Array<[string, string]> = [
  ["alias", `const alias = raw; return alias;`],
  ["object property", `return { value: raw }.value;`],
  ["destructuring", `const { value } = { value: raw }; return value;`],
  ["identity callback", `const identity = (value) => value; return identity(raw);`],
  ["promise resolve", `return await Promise.resolve(raw);`],
  ["conditional", `return condition ? raw : "small";`],
  ["short circuit", `return condition && raw;`],
  ["try finally", `try { return raw; } finally { cleanup(); }`],
  ["computed property", `const key = "value"; return ({ value: raw })[key];`],
  ["spread", `return { ...raw };`],
  ["callback argument", `return [raw].map((value) => value)[0];`],
  ["switch assignment", `let value = "small"; switch (kind) { case "raw": value = raw; break; } return value;`],
  ["loop assignment", `let value = "small"; for (const item of [raw]) value = item; return value;`],
  ["promise all", `const values = await Promise.all([raw, "small"]); return values[0];`],
  ["catch return", `try { throw new Error("x"); } catch (error) { return raw; }`],
  ["async identity", `async function keep(value) { return value; } return await keep(raw);`],
];

const safeBodies: Array<[string, string]> = [
  ["byte slice", `return raw.slice(0, 120);`],
  ["line selection", `return raw.split("\\n").slice(0, 3).join("\\n");`],
  ["scalar length", `return raw.length;`],
  ["scalar diagnostic", `return { bytes: raw.length, present: raw.length > 0 };`],
  ["ctx read", `return extensions.ctx_read({ id: "handle", length: 120 });`],
  ["ctx summarize", `return extensions.ctx_summarize({ text: raw, mode: "code", maxTokens: 120 });`],
  ["ctx offload", `return extensions.ctx_offload({ key: "raw", source: "read", data: raw });`],
  ["fovea selection", `return extensions.fovea_focus({ query: "needle", maxTokens: 120 });`],
  ["bounded callback", `return [raw].map((value) => value.slice(0, 40))[0];`],
  ["comparison", `return raw.includes("needle");`],
];

export function buildAdversarialCases(): AdversarialCase[] {
  const unsafe = unsafeBodies.map(([name, body]) => ({
    name: `unsafe/${name}`,
    family: name,
    expectation: "BLOCK" as const,
    program: `${unsafeSource}\n${body}`,
  }));
  const safe = safeBodies.map(([name, body]) => ({
    name: `safe/${name}`,
    family: name,
    expectation: "PASS" as const,
    program: `${safeSource}\n${body}`,
  }));
  return [...unsafe, ...safe];
}
