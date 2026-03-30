import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";

let child: ChildProcess | null = null;
let startedAt: number | null = null;
let lastError: string | null = null;

function projectRoot(): string {
    return process.cwd();
}

function spawnLogPath(): string {
    const dir = path.join(projectRoot(), "logs");
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            /* ignore */
        }
    }
    return path.join(dir, "bot-ui-spawn.log");
}

export function getBotProcessStatus(): {
    running: boolean;
    pid: number | null;
    startedAt: number | null;
    lastError: string | null;
} {
    const alive = child !== null && !child.killed && child.exitCode === null;
    return {
        running: Boolean(alive),
        pid: alive && child?.pid != null ? child.pid : null,
        startedAt: alive ? startedAt : null,
        lastError,
    };
}

export function startBotFromUi(): { ok: boolean; error?: string; pid?: number } {
    lastError = null;
    if (child && !child.killed && child.exitCode === null) {
        return { ok: false, error: "Bot process already running from this dashboard session." };
    }

    const cwd = projectRoot();
    const tsx = path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");
    const entry = path.join(cwd, "src", "index.ts");

    if (!fs.existsSync(tsx)) {
        return { ok: false, error: `tsx not found at ${tsx}. Run npm install in the project root.` };
    }
    if (!fs.existsSync(entry)) {
        return { ok: false, error: `Entry not found: ${entry}` };
    }

    const logFile = spawnLogPath();
    const header = `\n--- ${new Date().toISOString()} bot start (dashboard) ---\n`;
    try {
        fs.appendFileSync(logFile, header, "utf8");
    } catch {
        /* ignore */
    }

    const proc = spawn(
        process.execPath,
        ["--max-old-space-size=8192", tsx, entry],
        {
            cwd,
            env: { ...process.env },
            detached: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    const append = (chunk: Buffer, stream: "out" | "err"): void => {
        try {
            const tag = stream === "err" ? "[stderr] " : "";
            fs.appendFileSync(logFile, tag + chunk.toString("utf8"));
        } catch {
            /* ignore */
        }
    };

    proc.stdout?.on("data", (d: Buffer) => append(d, "out"));
    proc.stderr?.on("data", (d: Buffer) => append(d, "err"));

    proc.on("error", (err) => {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error(`[config-ui] bot spawn error: ${lastError}`);
    });

    proc.on("exit", (code, signal) => {
        try {
            fs.appendFileSync(
                logFile,
                `\n--- exit code=${code} signal=${signal ?? "none"} ---\n`,
                "utf8"
            );
        } catch {
            /* ignore */
        }
        if (child === proc) {
            child = null;
            startedAt = null;
        }
    });

    child = proc;
    startedAt = Date.now();

    // eslint-disable-next-line no-console
    console.log(`[config-ui] started bot pid=${proc.pid} (stdio → ${logFile})`);

    return { ok: true, pid: proc.pid };
}

export function stopBotFromUi(): { ok: boolean; error?: string } {
    lastError = null;
    if (!child || child.killed) {
        child = null;
        startedAt = null;
        return { ok: false, error: "No bot process was started from this dashboard." };
    }

    try {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
            if (child && !child.killed && child.exitCode === null) {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* ignore */
                }
            }
        }, 20_000);

        child.once("exit", () => {
            clearTimeout(killTimer);
        });

        // eslint-disable-next-line no-console
        console.log("[config-ui] sent SIGTERM to bot process");
        return { ok: true };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = msg;
        return { ok: false, error: msg };
    }
}

process.on("exit", () => {
    if (child && !child.killed) {
        try {
            child.kill("SIGTERM");
        } catch {
            /* ignore */
        }
    }
});
