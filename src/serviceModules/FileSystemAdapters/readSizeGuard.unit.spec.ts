import { describe, expect, it } from "vitest";
import {
    DESKTOP_READ_HARD_CAP_BYTES,
    FileTooLargeToReadError,
    MOBILE_READ_HARD_CAP_BYTES,
    getReadableLimitBytes,
    isFileTooLargeToRead,
} from "./readSizeGuard";

const MEBIBYTE = 1024 * 1024;

describe("getReadableLimitBytes", () => {
    it("uses the hard cap when no limit is configured", () => {
        expect(getReadableLimitBytes(true, 0)).toBe(MOBILE_READ_HARD_CAP_BYTES);
        expect(getReadableLimitBytes(false, 0)).toBe(DESKTOP_READ_HARD_CAP_BYTES);
    });

    it("lowers the limit when a smaller value is configured", () => {
        expect(getReadableLimitBytes(true, 5)).toBe(5 * MEBIBYTE);
        expect(getReadableLimitBytes(false, 5)).toBe(5 * MEBIBYTE);
    });

    it("never raises the limit above the hard cap", () => {
        expect(getReadableLimitBytes(true, 512)).toBe(MOBILE_READ_HARD_CAP_BYTES);
        expect(getReadableLimitBytes(false, 512)).toBe(DESKTOP_READ_HARD_CAP_BYTES);
    });
});

describe("isFileTooLargeToRead", () => {
    it("refuses files above the mobile hard cap", () => {
        expect(isFileTooLargeToRead(MOBILE_READ_HARD_CAP_BYTES + 1, 0, true)).toBe(true);
        expect(isFileTooLargeToRead(MOBILE_READ_HARD_CAP_BYTES, 0, true)).toBe(false);
    });

    it("refuses files above the desktop hard cap", () => {
        expect(isFileTooLargeToRead(DESKTOP_READ_HARD_CAP_BYTES + 1, 0, false)).toBe(true);
        expect(isFileTooLargeToRead(DESKTOP_READ_HARD_CAP_BYTES, 0, false)).toBe(false);
    });

    it("treats the boundary as readable", () => {
        expect(isFileTooLargeToRead(5 * MEBIBYTE, 5, true)).toBe(false);
        expect(isFileTooLargeToRead(5 * MEBIBYTE + 1, 5, true)).toBe(true);
    });

    it("respects a configured limit lower than the hard cap", () => {
        expect(isFileTooLargeToRead(7 * MEBIBYTE, 5, false)).toBe(true);
        expect(isFileTooLargeToRead(4 * MEBIBYTE, 5, false)).toBe(false);
    });

    it("falls back to the hard cap when the configured limit is higher", () => {
        expect(isFileTooLargeToRead(32 * MEBIBYTE, 512, true)).toBe(true);
        expect(isFileTooLargeToRead(32 * MEBIBYTE, 512, false)).toBe(false);
    });

    it("treats an unknown size as readable", () => {
        expect(isFileTooLargeToRead(0, 5, true)).toBe(false);
        expect(isFileTooLargeToRead(-1, 5, true)).toBe(false);
        expect(isFileTooLargeToRead(Number.NaN, 5, true)).toBe(false);
    });
});

describe("FileTooLargeToReadError", () => {
    it("carries the path, the size and the limit", () => {
        const error = new FileTooLargeToReadError("notes/big.bin", 20 * MEBIBYTE, MOBILE_READ_HARD_CAP_BYTES);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("FileTooLargeToReadError");
        expect(error.path).toBe("notes/big.bin");
        expect(error.sizeBytes).toBe(20 * MEBIBYTE);
        expect(error.limitBytes).toBe(MOBILE_READ_HARD_CAP_BYTES);
        expect(error.message).toContain("notes/big.bin");
        expect(error.message).toContain(String(20 * MEBIBYTE));
    });
});
