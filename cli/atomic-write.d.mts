/** Types for atomic-write.mjs, so the worker's tests can hold it to the same tests as the original. */
export function fsyncDirSync(dir: string): void;
export function writeFileAtomicSync(file: string, data: string, mode?: number, opts?: { durable?: boolean }): void;
export const RENAME_RETRY_MS: readonly number[];
export function renameRetryingSync(from: string, to: string, platform?: NodeJS.Platform, rename?: (from: string, to: string) => void): void;
