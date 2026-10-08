// Only the test helpers that run a reference decoder (`xz`) use this; the
// project does not depend on the Node typings.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: { input?: Uint8Array; maxBuffer?: number; stdio?: unknown },
  ): Uint8Array;
}
