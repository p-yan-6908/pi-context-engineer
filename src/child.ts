import { spawn } from "node:child_process";

export interface ChildPiOptions {
  cwd: string;
  model?: string;
  /** Disable all model tool calls; used for pure summarization. */
  noTools?: boolean;
  timeoutMs?: number;
}

/**
 * Run a short-lived Pi process with an isolated session and return its text.
 * The child inherits Pi's configured credentials and environment, but does
 * not inherit the parent conversation or extensions.
 */
export function runChildPi(prompt: string, options: ChildPiOptions): Promise<string> {
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-session",
    "--no-approve",
    "--print",
    "--mode",
    "text",
  ];

  if (options.noTools) args.push("--no-tools");
  if (options.model) args.push("--model", options.model);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_BIN ?? "pi", args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Child Pi timed out after ${options.timeoutMs ?? 120000} ms.`));
    }, options.timeoutMs ?? 120000);

    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(-2000);
        reject(new Error(`Child Pi exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}
