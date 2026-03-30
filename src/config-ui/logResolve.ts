import * as fs from "fs";
import * as path from "path";
import { parseEnvFile, envPath } from "./envFile";

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function dateStampLocal(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function readEnvMap(): Record<string, string> {
    try {
        const raw = fs.readFileSync(envPath(), "utf8");
        return parseEnvFile(raw);
    } catch {
        return {};
    }
}

/**
 * Resolves the same log file path as `setupConsoleFileLogging` / console-file.ts
 * using current `.env` (or defaults).
 */
export function resolveLogFilePathFromEnv(): string | null {
    const env = readEnvMap();
    const now = new Date();
    const stamp = dateStampLocal(now);

    const fromUser = env.LOG_FILE_PATH?.trim();
    if (fromUser) {
        const withDate = fromUser.split("{date}").join(stamp);
        return path.isAbsolute(withDate) ? withDate : path.resolve(process.cwd(), withDate);
    }

    const logDir = (env.LOG_DIR || "logs").trim() || "logs";
    const prefix = (env.LOG_FILE_PREFIX || "bot").trim() || "bot";
    const dailyName = `${prefix}-${stamp}.log`;
    const resolvedDir = path.isAbsolute(logDir) ? logDir : path.resolve(process.cwd(), logDir);
    return path.join(resolvedDir, dailyName);
}

/** Read last `maxBytes` from file (UTF-8); returns "" if missing. */
export function readTailBytes(filePath: string, maxBytes: number): string {
    if (!fs.existsSync(filePath)) return "";
    const st = fs.statSync(filePath);
    const len = st.size;
    const start = Math.max(0, len - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
        const toRead = len - start;
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, start);
        return buf.toString("utf8");
    } finally {
        fs.closeSync(fd);
    }
}
