// Running a project's Varis generator, for varis build.
//
// The CLI never reads source code. It finds the project's language from a
// marker file and runs that language's generator, which reads every define
// call and rewrites the services list in varis.json. This table of markers
// and commands is all the CLI knows about languages.
//
// Every generator honours one contract (see @usevaris/build's cli.ts):
//   exit 0  stdout: one JSON line { "services": [slugs], "warnings": [text] }
//   exit 1  stderr: one JSON line per problem { "file", "line", "message" }
//   exit 2  stderr: one JSON line; the generator itself crashed
// A launcher such as npx may add its own lines to stderr, so lines that
// aren't the contract's JSON are set aside rather than trusted.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./constants.ts";

export type Language = {
  /** Shown to the developer. */
  name: string;
  /** The file whose presence says the project is this language. */
  marker: string;
  /** The generator, run in the project folder. */
  command: [string, ...string[]];
};

/**
 * The @usevaris/build major version this CLI speaks. npx fetches the latest
 * release within it, so a fix reaches developers without a CLI release.
 */
export const BUILD_MAJOR = 1;

export const LANGUAGES: readonly Language[] = [
  {
    name: "TypeScript or JavaScript",
    marker: "package.json",
    command: ["npx", "--yes", `@usevaris/build@${BUILD_MAJOR}`],
  },
];

export async function detectLanguage(projectDir: string): Promise<Language | null> {
  for (const language of LANGUAGES) {
    try {
      await access(path.join(projectDir, language.marker));
      return language;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * The command to run. VARIS_BUILD_COMMAND replaces it, for developing Varis
 * itself against a generator that isn't on npm yet, for example
 * `node ~/dev/varis-ts/packages/build/dist/cli.js`. Split on spaces.
 */
export function generatorCommand(language: Language, env: Env): string[] {
  const override = env.VARIS_BUILD_COMMAND?.trim();
  return override ? override.split(/\s+/) : [...language.command];
}

export type RunResult =
  | { status: "ran"; code: number; stdout: string; stderr: string }
  /** The program itself isn't installed, such as npx without Node.js. */
  | { status: "missing"; program: string };

export type Runner = (command: string[], cwd: string) => Promise<RunResult>;

/** Runs `command` in `cwd`, capturing both streams. */
export const runCommand: Runner = (command, cwd) =>
  new Promise((resolve) => {
    const [program, ...args] = command as [string, ...string[]];
    // npx is npx.cmd on Windows, which only runs through a shell.
    const child = spawn(program, args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error: Error & { code?: string }) => {
      if (error.code === "ENOENT") resolve({ status: "missing", program });
      else resolve({ status: "ran", code: 2, stdout, stderr: String(error) });
    });
    child.on("close", (code) =>
      resolve({ status: "ran", code: code ?? 2, stdout, stderr })
    );
  });

export type Problem = { file: string; line: number; message: string };

export type GeneratorOutcome =
  | { kind: "built"; services: string[]; warnings: string[] }
  | { kind: "problems"; problems: Problem[] }
  | { kind: "crashed"; message: string }
  /** Output the contract doesn't explain, such as npx failing to download. */
  | { kind: "unexpected"; code: number; output: string };

/** Reads a finished run against the generator contract. */
export function readOutcome(code: number, stdout: string, stderr: string): GeneratorOutcome {
  const problems = parseProblems(stderr);

  if (code === 0) {
    const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
    try {
      const result = JSON.parse(line) as { services?: unknown; warnings?: unknown };
      if (Array.isArray(result.services)) {
        return {
          kind: "built",
          services: result.services.map(String),
          warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
        };
      }
    } catch {
      // Falls through to unexpected.
    }
  }

  if (code === 1 && problems.length > 0) return { kind: "problems", problems };

  if (code === 2 && problems.length > 0) {
    return { kind: "crashed", message: problems.map((p) => p.message).join("\n") };
  }

  return {
    kind: "unexpected",
    code,
    output: [stderr.trim(), stdout.trim()].filter(Boolean).join("\n"),
  };
}

/** The contract's JSON lines in `stderr`, skipping anything else. */
function parseProblems(stderr: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Partial<Problem>;
      if (typeof value.message === "string") {
        problems.push({
          file: typeof value.file === "string" ? value.file : "",
          line: typeof value.line === "number" ? value.line : 0,
          message: value.message,
        });
      }
    } catch {
      // A launcher's line, not the generator's.
    }
  }
  return problems;
}

/**
 * Runs `command` with its output shown as it goes, for a package manager
 * whose progress the developer should see. Resolves to its exit code, or
 * "missing" when the program isn't installed.
 */
export const runCommandShown = (command: string[]): Promise<number | "missing"> =>
  new Promise((resolve) => {
    const [program, ...args] = command as [string, ...string[]];
    // scoop and npx are .cmd shims on Windows, which only run through a
    // shell.
    const child = spawn(program, args, {
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("error", (error: Error & { code?: string }) =>
      resolve(error.code === "ENOENT" ? "missing" : 1)
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
