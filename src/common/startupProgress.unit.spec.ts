import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    STARTUP_PHASE_WEIGHTS,
    STARTUP_PHASES,
    beginStartupPhase,
    completeStartupPhase,
    finishStartupProgress,
    observeStartupLog,
    reportStartupPhaseProgress,
    resetStartupProgress,
    startupProgress,
} from "./startupProgress";

describe("startupProgress weights", () => {
    it("assigns every phase a positive weight that sums to 100", () => {
        const sum = STARTUP_PHASES.reduce((total, phase) => total + STARTUP_PHASE_WEIGHTS[phase], 0);
        expect(sum).toBe(100);
        for (const phase of STARTUP_PHASES) expect(STARTUP_PHASE_WEIGHTS[phase]).toBeGreaterThan(0);
    });
});

describe("startupProgress", () => {
    beforeEach(() => {
        resetStartupProgress();
    });

    it("starts a run active at zero with no phase", () => {
        expect(startupProgress.value).toMatchObject({ percent: 0, active: true, phase: null, label: "" });
    });

    it("retires the database phase when the scan reports its first items", () => {
        // The vault scan only starts after the database opened.
        reportStartupPhaseProgress("scan", 0, 100);
        expect(startupProgress.value).toMatchObject({ phase: "scan", label: "Scanning vault" });
        expect(startupProgress.value.percent).toBe(STARTUP_PHASE_WEIGHTS.database);

        reportStartupPhaseProgress("scan", 50);
        expect(startupProgress.value.percent).toBe(STARTUP_PHASE_WEIGHTS.database + STARTUP_PHASE_WEIGHTS.scan / 2);
    });

    it("never reports a lower percentage than already shown", () => {
        reportStartupPhaseProgress("customisations", 90, 100);
        const high = startupProgress.value.percent;
        reportStartupPhaseProgress("customisations", 10);
        expect(startupProgress.value.percent).toBe(high);
    });

    it("never reaches 100 while a start-up is still running", () => {
        reportStartupPhaseProgress("customisations", 100, 100);
        reportStartupPhaseProgress("hidden-files", 100, 100);
        beginStartupPhase("finalising");
        expect(startupProgress.value.active).toBe(true);
        expect(startupProgress.value.percent).toBe(90);
        // Only readiness may show a full ring, so the last phase still stops one short.
        completeStartupPhase("finalising");
        expect(startupProgress.value.percent).toBe(99);
    });

    it("keeps overlapping customisation and hidden-file phases independent", () => {
        beginStartupPhase("customisations");
        expect(startupProgress.value.percent).toBe(STARTUP_PHASE_WEIGHTS.database + STARTUP_PHASE_WEIGHTS.scan);
        // Hidden File Sync starting must not report customisation sync as finished.
        beginStartupPhase("hidden-files");
        expect(startupProgress.value.percent).toBe(STARTUP_PHASE_WEIGHTS.database + STARTUP_PHASE_WEIGHTS.scan);
        // And a customisation report must still be accepted afterwards.
        reportStartupPhaseProgress("customisations", 100, 100);
        expect(startupProgress.value.percent).toBe(
            STARTUP_PHASE_WEIGHTS.database + STARTUP_PHASE_WEIGHTS.scan + STARTUP_PHASE_WEIGHTS.customisations
        );
    });

    it("does not rewind the current phase when an earlier boundary fires late", () => {
        beginStartupPhase("customisations");
        // e.g. a database reopen reported after the customisation sync already started
        beginStartupPhase("scan");
        expect(startupProgress.value.phase).toBe("customisations");
    });

    it("counts an empty phase as complete without stalling", () => {
        beginStartupPhase("customisations");
        completeStartupPhase("customisations");
        completeStartupPhase("hidden-files");
        expect(startupProgress.value.percent).toBe(90);
    });

    it("finishes at 100 and ignores later work", () => {
        reportStartupPhaseProgress("customisations", 5, 10);
        startupProgress.value; // reading clears the reactive dirty flag, so the next change notifies
        const finishHandler = vi.fn();
        startupProgress.onChanged(finishHandler);
        finishStartupProgress();
        expect(startupProgress.value).toMatchObject({ percent: 100, active: false, phase: null });
        expect(finishHandler).toHaveBeenCalled();

        const before = startupProgress.value;
        reportStartupPhaseProgress("hidden-files", 1, 10);
        completeStartupPhase("customisations");
        beginStartupPhase("finalising");
        expect(startupProgress.value).toBe(before);
    });

    it("resets to a fresh run after a reload", () => {
        reportStartupPhaseProgress("hidden-files", 10, 10);
        finishStartupProgress();
        resetStartupProgress();
        expect(startupProgress.value).toMatchObject({
            percent: 0,
            active: true,
            phase: null,
            completed: 0,
            total: 0,
        });
    });
});

describe("observeStartupLog", () => {
    beforeEach(() => {
        resetStartupProgress();
    });

    it("reads the OfflineScanner processed counter from the service log line", () => {
        // Shape produced by createInstanceLogFunction("SF:OfflineScanner") in commonlib 0.3.2.
        observeStartupLog("[SF:OfflineScanner]\u200a Processing: 1575/4934");
        expect(startupProgress.value).toMatchObject({ phase: "scan", completed: 1575, total: 4934 });
    });

    it("ignores unrelated services and malformed counts", () => {
        observeStartupLog("[ConfigSync]\u200a Scanning customizations...");
        expect(startupProgress.value.phase).toBeNull();
        observeStartupLog("[SF:OfflineScanner]\u200a Processing: 0/0");
        expect(startupProgress.value.total).toBe(0);
        observeStartupLog({ message: "not a string" });
        expect(startupProgress.value.phase).toBeNull();
    });

    it("ignores scan lines once the plug-in is ready", () => {
        finishStartupProgress();
        observeStartupLog("[SF:OfflineScanner]\u200a Processing: 10/100");
        expect(startupProgress.value).toMatchObject({ percent: 100, active: false, phase: null });
    });
});
