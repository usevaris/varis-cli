import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InitDeps, runInit } from "../src/commands/init.ts";
import { BLOCK_BEGIN, BLOCK_END } from "../src/lib/agent-instructions.ts";
import type { ApiRequestFn } from "../src/lib/api.ts";
import { VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import { type CredentialsLocation, saveToken } from "../src/lib/credentials.ts";
import type { Output } from "../src/lib/output.ts";
import type { Prompter } from "../src/lib/prompt.ts";

const TOKEN = `var_dt_${"a".repeat(40)}`;
const ACME = { id: "var_ownr_aaaaaaaaaaaaaa", name: "Acme Corp", role: "admin" };
const BANK = { id: "var_ownr_bbbbbbbbbbbbbb", name: "World Bank", role: "member" };

let project: string;
let home: string;
let credentials: CredentialsLocation;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "varis-cli-project-"));
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-home-"));
  credentials = { env: {}, platform: process.platform, home };
  await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

type Answers = { select?: number | null; inputs?: (string | null)[] };

function setup(
  owners = [ACME],
  answers: Answers = {},
  overrides: Partial<InitDeps> = {},
) {
  const asked: string[] = [];
  const inputs = [...(answers.inputs ?? [])];
  const prompter: Prompter = {
    interactive: answers.select !== undefined || answers.inputs !== undefined,
    select: async (question, choices, initial) => {
      asked.push(`select: ${question} [initial ${initial}]`);
      const pick = answers.select;
      return pick === null || pick === undefined ? null : choices[pick]!.value;
    },
    input: async (question, defaultValue) => {
      asked.push(`input: ${question} [default ${defaultValue ?? "none"}]`);
      const next = inputs.shift();
      return next === undefined ? "" : next;
    },
  };

  const request = (async (_method, apiPath) => {
    if (apiPath === "/v1/me/owners") return { ok: true, status: 200, body: { owners } };
    throw new Error(`unexpected ${apiPath}`);
  }) as ApiRequestFn;

  let signedIn = 0;
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: () => {},
    styled: false,
  };
  const deps: InitDeps = {
    cwd: project,
    env: {},
    credentials,
    request,
    prompter,
    signIn: async () => {
      signedIn++;
      await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
      return 0;
    },
    ...overrides,
  };
  return { deps, output, out, err, asked, signIns: () => signedIn };
}

const read = (file: string) => readFile(path.join(project, file), "utf8");
const manifest = async () => JSON.parse(await read("varis.json"));

describe("a new project", () => {
  it("writes varis.json, AGENTS.md, and CLAUDE.md, asking nothing", async () => {
    const t = setup([ACME], { inputs: [] });

    expect(await runInit([], t.output, t.deps)).toBe(0);

    expect(t.asked).toEqual([]);
    expect(await manifest()).toEqual({ owner_id: ACME.id, services: [] });
    const agents = await read("AGENTS.md");
    expect(agents).toContain(BLOCK_BEGIN);
    expect(agents).toContain("node_modules/@usevaris/sdk/docs/agents.md");
    expect(agents).toContain(BLOCK_END);
    expect(await read("CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(t.out[0]).toBe("✓ Created varis.json.");
  });

  it("uses a single owner without asking, and names it with its ID", async () => {
    const t = setup([ACME], { inputs: [] });
    await runInit([], t.output, t.deps);
    expect(t.asked).toEqual([]);
    expect(t.out.join("\n")).toContain(`Acme Corp (${ACME.id})`);
  });

  it("shows the command that sets both base URLs, the note, and the docs", async () => {
    const t = setup();
    await runInit([], t.output, t.deps);
    const printed = t.out.join("\n");
    expect(printed).toContain("Base URL:       not set");
    expect(printed).toContain("Test base URL:  not set");
    expect(printed).toContain(
      "varis init --base-url <BASE_URL> --test-base-url <TEST_BASE_URL>",
    );
    expect(printed).toContain("joined to base_url when you publish and to test_base_url when you run varis test");
    expect(printed).toContain("https://usevaris.com/docs/services/endpoints");
  });

  it("fills in the command with whichever base URL is already set", async () => {
    const t = setup();
    await runInit(["--base-url", "https://api.example.com"], t.output, t.deps);
    expect(t.out.join("\n")).toContain(
      "varis init --base-url https://api.example.com --test-base-url <TEST_BASE_URL>",
    );
  });

  it("drops the command once both are set", async () => {
    const t = setup();
    await runInit(
      ["--base-url", "https://api.example.com", "--test-base-url", "http://localhost:3000"],
      t.output,
      t.deps,
    );
    expect(t.out.join("\n")).not.toContain("varis init --base-url");
  });
});

describe("--test-base-url", () => {
  it("accepts a local http address, and never mixes it with base_url", async () => {
    const t = setup();
    expect(
      await runInit(
        ["--base-url", "https://api.example.com/", "--test-base-url", "http://localhost:3000/"],
        t.output,
        t.deps,
      ),
    ).toBe(0);
    const text = await read("varis.json");
    expect(JSON.parse(text)).toEqual({
      owner_id: ACME.id,
      base_url: "https://api.example.com",
      test_base_url: "http://localhost:3000",
      services: [],
    });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "owner_id",
      "base_url",
      "test_base_url",
      "services",
    ]);
  });

  it("rejects something that isn't a full URL, before signing in", async () => {
    const t = setup();
    expect(await runInit(["--test-base-url", "localhost:3000"], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("--test-base-url");
    expect(t.signIns()).toBe(0);
  });

  it("keeps an existing test base URL when not given", async () => {
    await writeFile(
      path.join(project, "varis.json"),
      JSON.stringify({ owner_id: ACME.id, test_base_url: "http://localhost:4000", services: [] }),
    );
    const t = setup();
    await runInit(["--base-url", "https://api.example.com"], t.output, t.deps);
    expect((await manifest()).test_base_url).toBe("http://localhost:4000");
  });
});

describe("choosing between owners", () => {
  it("shows the picker with each owner's ID, starting on the current one", async () => {
    await writeFile(path.join(project, "varis.json"), JSON.stringify({ owner_id: BANK.id, services: [] }));
    const t = setup([ACME, BANK], { select: 0 });

    expect(await runInit([], t.output, t.deps)).toBe(0);
    expect(t.asked[0]).toBe("select: Which owner does this project publish for? [initial 1]");
    expect((await manifest()).owner_id).toBe(ACME.id);
  });

  it("changes nothing when the picker is cancelled", async () => {
    const t = setup([ACME, BANK], { select: null });
    expect(await runInit([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("Nothing was changed");
    await expect(read("varis.json")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(read("AGENTS.md")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("flags", () => {
  it("--owner and --base-url together ask nothing, as CI needs", async () => {
    const t = setup([ACME, BANK]);
    expect(
      await runInit(["--owner", BANK.id, "--base-url", "https://api.example.com"], t.output, t.deps),
    ).toBe(0);
    expect(t.asked).toEqual([]);
    expect(await manifest()).toEqual({
      owner_id: BANK.id,
      base_url: "https://api.example.com",
      services: [],
    });
  });

  it("rejects an owner you don't belong to, listing yours, and writes nothing", async () => {
    const t = setup([ACME, BANK]);
    expect(await runInit(["--owner=var_ownr_zzzzzzzzzzzzzz"], t.output, t.deps)).toBe(1);
    const printed = t.err.join("\n");
    expect(printed).toContain("var_ownr_zzzzzzzzzzzzzz");
    expect(printed).toContain(`World Bank (${BANK.id})`);
    await expect(read("varis.json")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bad --base-url before signing in or asking anything", async () => {
    const t = setup([ACME], {}, { credentials: { env: {}, platform: process.platform, home: "/nonexistent" } });
    expect(await runInit(["--base-url", "https://localhost:3000"], t.output, t.deps)).toBe(1);
    expect(t.signIns()).toBe(0);
    expect(t.err.join("\n")).toContain("--base-url must be your production address");
  });

  it("rejects an unknown option", async () => {
    const t = setup();
    expect(await runInit(["--base_url", "https://x.io"], t.output, t.deps)).toBe(2);
  });
});

describe("without a terminal", () => {
  it("needs --owner when you belong to several owners and none is set", async () => {
    const t = setup([ACME, BANK]);
    expect(await runInit([], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("--owner <id>");
  });

  it("keeps the existing owner and base URL", async () => {
    await writeFile(
      path.join(project, "varis.json"),
      JSON.stringify({ owner_id: BANK.id, base_url: "https://api.example.com", services: [] }),
    );
    const t = setup([ACME, BANK]);
    expect(await runInit([], t.output, t.deps)).toBe(0);
    expect(await manifest()).toMatchObject({ owner_id: BANK.id, base_url: "https://api.example.com" });
  });
});

describe("an existing project", () => {
  it("keeps services and any other key, and orders owner_id and base_url first", async () => {
    const services = [{ slug: "weather", endpoint_url: "https://api.example.com/weather" }];
    await writeFile(
      path.join(project, "varis.json"),
      JSON.stringify({ services, extra: true, owner_id: ACME.id }),
    );
    const t = setup([ACME], {}, {});

    expect(await runInit(["--base-url", "https://api.example.com"], t.output, t.deps)).toBe(0);

    const text = await read("varis.json");
    expect(Object.keys(JSON.parse(text))).toEqual(["owner_id", "base_url", "extra", "services"]);
    expect(JSON.parse(text).services).toEqual(services);
    expect(t.out[0]).toBe("✓ Updated varis.json.");
  });

  it("adds the block to an existing AGENTS.md, keeping what was there", async () => {
    await writeFile(path.join(project, "AGENTS.md"), "# Our rules\n\nUse tabs.\n");
    await writeFile(path.join(project, "CLAUDE.md"), "Be concise.");
    const t = setup();

    await runInit([], t.output, t.deps);

    const agents = await read("AGENTS.md");
    expect(agents.startsWith("# Our rules\n\nUse tabs.\n\n")).toBe(true);
    expect(agents).toContain(BLOCK_BEGIN);
    expect(await read("CLAUDE.md")).toBe("Be concise.\n@AGENTS.md\n");
  });

  it("replaces only the text between the markers in an existing block", async () => {
    await writeFile(
      path.join(project, "AGENTS.md"),
      `# Before\n\n${BLOCK_BEGIN}\nold, edited by hand\n${BLOCK_END}\n\n# After\n`,
    );
    const t = setup();

    await runInit([], t.output, t.deps);

    const agents = await read("AGENTS.md");
    expect(agents.startsWith("# Before\n\n")).toBe(true);
    expect(agents.endsWith(`${BLOCK_END}\n\n# After\n`)).toBe(true);
    expect(agents).not.toContain("old, edited by hand");
    expect(agents.split(BLOCK_BEGIN)).toHaveLength(2);
  });

  it("changes nothing the second time it runs", async () => {
    const first = setup();
    await runInit(["--base-url", "https://api.example.com"], first.output, first.deps);
    const before = await Promise.all(["varis.json", "AGENTS.md", "CLAUDE.md"].map(read));

    const second = setup();
    expect(await runInit([], second.output, second.deps)).toBe(0);

    const after = await Promise.all(["varis.json", "AGENTS.md", "CLAUDE.md"].map(read));
    expect(after).toEqual(before);
    expect(second.out[0]).toBe("✓ varis.json is already up to date.");
    expect(second.out.join("\n")).not.toContain("AGENTS.md");
  });

  it("refuses to overwrite a varis.json it can't read", async () => {
    await writeFile(path.join(project, "varis.json"), "{ not json");
    const t = setup();
    expect(await runInit([], t.output, t.deps)).toBe(1);
    expect(await read("varis.json")).toBe("{ not json");
  });
});

describe("signing in", () => {
  it("runs login first when this machine isn't signed in", async () => {
    await rm(home, { recursive: true, force: true });
    const t = setup();
    expect(await runInit([], t.output, t.deps)).toBe(0);
    expect(t.signIns()).toBe(1);
    expect(t.err[0]).toBe("You need to sign in first.");
  });

  it("stops if signing in fails, writing nothing", async () => {
    await rm(home, { recursive: true, force: true });
    const t = setup([ACME], {}, { signIn: async () => 1 });
    expect(await runInit([], t.output, t.deps)).toBe(1);
    await expect(read("varis.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
