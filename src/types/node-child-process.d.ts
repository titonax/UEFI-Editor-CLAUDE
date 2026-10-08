// Only the test helpers that run a reference tool (`xz`, a compiled copy of the
// project's own C decoder) use these; the project does not depend on the Node
// typings.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: { input?: Uint8Array; maxBuffer?: number; timeout?: number; stdio?: unknown },
  ): Uint8Array;
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
