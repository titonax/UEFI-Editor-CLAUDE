import { describe, expect, it } from "vitest";
import packageJson from "../../package.json?raw";
import binaryPatchReviewer from "../../.claude/agents/binary-patch-reviewer.md?raw";
import silentFailureHunter from "../../.claude/agents/silent-failure-hunter.md?raw";
import skill from "../../.claude/skills/add-firmware-case/SKILL.md?raw";
import { contentFields, minimumComparedFields } from "./caseMatcher";
import { similarThreshold } from "./corpusKnowledge";

// The skill is instructions for an agent, so it must not drift from the
// repository it describes. Lazy globs: only file names are used. (Vite's glob
// skips dot directories, so the .claude files are imported directly instead.)
const repositoryFiles = new Set(
  [
    ...Object.keys(import.meta.glob("/src/**/*.{ts,tsx,md,json}")),
    ...Object.keys(import.meta.glob("/docs/**/*.md")),
  ].map((path) => path.slice(1)),
);

const text: string = skill;
const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;

describe("the add-firmware-case skill", () => {
  it("has the front matter a skill needs, named after its directory", () => {
    const match = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);

    expect(match, "front matter with a one-line name and description").not.toBeNull();
    expect(match?.[1]).toBe("add-firmware-case");
    expect((match?.[2] ?? "").length).toBeGreaterThan(40);
    expect((match?.[2] ?? "").length).toBeLessThanOrEqual(1024);
  });

  it("only points at repository files that exist", () => {
    const paths = [...text.matchAll(/`((?:src|docs|\.claude)\/[^`\s]+)`/g)]
      .map((match) => match[1])
      .filter((path) => !path.includes("<"));

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(repositoryFiles.has(path), `${path} does not exist`).toBe(true);
    }
  });

  it("only runs npm scripts that exist", () => {
    const named = [...text.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1]);
    if (/npm test\b/.test(text)) named.push("test");

    expect(named).toEqual(expect.arrayContaining(["cases:check", "lint", "build", "test"]));
    for (const name of named) expect(scripts[name], `npm run ${name} does not exist`).toBeDefined();
  });

  it("names agents that exist", () => {
    const agents: Record<string, string> = {
      "silent-failure-hunter": silentFailureHunter,
      "binary-patch-reviewer": binaryPatchReviewer,
    };
    for (const [name, definition] of Object.entries(agents)) {
      expect(text).toContain(name);
      expect(definition).toContain(`name: ${name}`);
    }
  });

  it("quotes the thresholds the code actually uses", () => {
    expect(text).toContain(`at least ${String(Math.round(similarThreshold * 100))}%`);
    expect(text).toContain("in no structural field");
    expect(text).toContain("beyond\n     container, family and generation");
    for (const field of contentFields) expect(text.toLowerCase()).toContain(field === "formSets" ? "formsets" : field);
    expect(text).toContain(`at least ${String(minimumComparedFields)} comparable fields`);
  });

  it("keeps the rules that matter most", () => {
    expect(text).toMatch(/Never commit firmware/);
    expect(text).toMatch(/Never generalise from one case/);
    expect(text).toMatch(/unresolved/);
  });
});
