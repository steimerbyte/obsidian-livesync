const MEBIBYTE = 1024 * 1024;

/** Refuse to hold a single file larger than this in memory on a mobile device. */
export const MOBILE_READ_HARD_CAP_BYTES = 16 * MEBIBYTE;
/** Refuse to hold a single file larger than this in memory on a desktop device. */
export const DESKTOP_READ_HARD_CAP_BYTES = 64 * MEBIBYTE;

/**
 * The size at or below which a read is attempted. The hard cap is absolute: a configured limit can only
 * lower it, never raise it, so a stale or generous setting cannot reintroduce an out-of-memory crash.
 */
export function getReadableLimitBytes(isMobile: boolean, configuredMaxMB: number): number {
    const hardCap = isMobile ? MOBILE_READ_HARD_CAP_BYTES : DESKTOP_READ_HARD_CAP_BYTES;
    if (!Number.isFinite(configuredMaxMB) || configuredMaxMB <= 0) return hardCap;
    return Math.min(hardCap, Math.floor(configuredMaxMB * MEBIBYTE));
}

/**
 * Decides whether a file is too large to be read into memory.
 * A size of zero or less means the size is unknown, which is never treated as too large.
 */
export function isFileTooLargeToRead(sizeBytes: number, configuredMaxMB: number, isMobile: boolean): boolean {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return false;
    return sizeBytes > getReadableLimitBytes(isMobile, configuredMaxMB);
}

export class FileTooLargeToReadError extends Error {
    constructor(
        readonly path: string,
        readonly sizeBytes: number,
        readonly limitBytes: number
    ) {
        super(
            `Refusing to read "${path}" (${sizeBytes} bytes). ` +
                `It exceeds the readable size limit of ${limitBytes} bytes, so it must be moved out of the ` +
                `synchronised Vault or excluded before it can be synchronised.`
        );
        this.name = "FileTooLargeToReadError";
    }
}
