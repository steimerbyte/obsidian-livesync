import { Platform, type App } from "@/deps";
import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import {
    FileAccessBase,
    type ExtractFile,
    type FileAccessBaseDependencies,
} from "@vrtmrz/livesync-commonlib/compat/serviceModules/FileAccessBase";
import { ObsidianFileSystemAdapter } from "./FileSystemAdapters/ObsidianFileSystemAdapter";
import { FileTooLargeToReadError, getReadableLimitBytes } from "./FileSystemAdapters/readSizeGuard";

type NativeFile = ExtractFile<ObsidianFileSystemAdapter>;

/**
 * Obsidian-specific implementation of FileAccessBase
 * Uses ObsidianFileSystemAdapter for platform-specific operations
 *
 * Reads are size-guarded here because a single whole-file read is the one operation that can exhaust
 * memory outright. Writes, directory listings and strided metadata reads are left alone.
 */
export class FileAccessObsidian extends FileAccessBase<ObsidianFileSystemAdapter> {
    /** Paths already reported, so a file retried in a loop is logged once rather than every attempt. */
    private readonly reportedOversizedPaths = new Set<string>();

    constructor(app: App, dependencies: FileAccessBaseDependencies) {
        const adapter = new ObsidianFileSystemAdapter(app);
        super(adapter, dependencies);
    }

    /**
     * Resolves the size without reading the file, preferring information Obsidian has already indexed.
     * Returns 0 when the size cannot be determined.
     */
    private async resolveReadSize(file: NativeFile | string, path: string): Promise<number> {
        if (this.adapter.typeGuard.isFile(file)) return file.stat.size;
        const resolved = await this.adapter.getAbstractFileByPath(path);
        if (this.adapter.typeGuard.isFile(resolved)) return resolved.stat.size;
        return (await this.adapter.storage.trystat(path))?.size ?? 0;
    }

    private async assertReadable(file: NativeFile | string): Promise<void> {
        const path = this.getPath(file);
        const size = await this.resolveReadSize(file, path);
        if (size <= 0) return;
        const isMobile = Platform.isMobile;
        const limitBytes = getReadableLimitBytes(isMobile, this.settingService.currentSettings().syncMaxSizeInMB);
        if (size <= limitBytes) return;
        if (!this.reportedOversizedPaths.has(path)) {
            this.reportedOversizedPaths.add(path);
            this._log(
                `Refusing to read "${path}" (${size} bytes): it exceeds the readable size limit of ${limitBytes} bytes`,
                LOG_LEVEL_NOTICE
            );
        }
        throw new FileTooLargeToReadError(path, size, limitBytes);
    }

    override async adapterRead(file: NativeFile | string): Promise<string> {
        await this.assertReadable(file);
        return await super.adapterRead(file);
    }

    override async adapterReadBinary(file: NativeFile | string): Promise<ArrayBuffer> {
        await this.assertReadable(file);
        return await super.adapterReadBinary(file);
    }

    override async adapterReadAuto(file: NativeFile | string): Promise<string | ArrayBuffer> {
        await this.assertReadable(file);
        return await super.adapterReadAuto(file);
    }

    override async vaultRead(file: NativeFile): Promise<string> {
        await this.assertReadable(file);
        return await super.vaultRead(file);
    }

    override async vaultReadBinary(file: NativeFile): Promise<ArrayBuffer> {
        await this.assertReadable(file);
        return await super.vaultReadBinary(file);
    }

    override async vaultReadAuto(file: NativeFile): Promise<string | ArrayBuffer> {
        await this.assertReadable(file);
        return await super.vaultReadAuto(file);
    }

    override async vaultCacheRead(file: NativeFile): Promise<string> {
        await this.assertReadable(file);
        return await super.vaultCacheRead(file);
    }
}
