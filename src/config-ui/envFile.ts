import * as fs from "fs";
import * as path from "path";
import { ALL_SCHEMA_KEYS, SENSITIVE_KEYS, getFieldMeta, type FieldType } from "./configSchema";

const ENV_FILENAME = ".env";

export function envPath(): string {
    return path.resolve(process.cwd(), ENV_FILENAME);
}

export function backupPath(): string {
    return path.resolve(process.cwd(), ".env.backup");
}

/**
 * Parse KEY=value lines from .env content. Does not expand variables.
 */
export function parseEnvFile(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1);
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

function escapeEnvValue(value: string): string {
    if (/[\s#"']/.test(value) || value === "") {
        return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
}

function formatLine(key: string, value: string): string {
    return `${key}=${escapeEnvValue(value)}`;
}

/**
 * Write a full snapshot of `merged` to `.env`.
 * Caller is responsible for merging disk state + form values (including deletes).
 * Keys not in `merged` are omitted from the file (except non-schema keys appended below).
 */
export function writeEnvFile(merged: Record<string, string>): { written: boolean; error?: string } {
    const p = envPath();
    const rawExists = fs.existsSync(p);

    const lines: string[] = [
        "# Polymarket trading bot configuration",
        `# Last updated: ${new Date().toISOString()}`,
        "# Restart the bot after saving for changes to apply.",
        "",
    ];

    const schemaSet = new Set(ALL_SCHEMA_KEYS);
    for (const k of ALL_SCHEMA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(merged, k) && merged[k] !== undefined) {
            lines.push(formatLine(k, merged[k]));
        }
    }

    for (const k of Object.keys(merged).sort()) {
        if (schemaSet.has(k)) continue;
        lines.push(formatLine(k, merged[k]));
    }

    const body = lines.join("\n") + "\n";

    try {
        if (rawExists) {
            fs.copyFileSync(p, backupPath());
        }
        fs.writeFileSync(p, body, "utf8");
        return { written: true };
    } catch (e) {
        return {
            written: false,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

export function validateValue(key: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
    const meta = getFieldMeta(key);
    const t: FieldType = meta?.type ?? "string";
    const s = raw.trim();

    if (t === "boolean") {
        const l = s.toLowerCase();
        if (s === "") return { ok: true, value: "false" };
        if (l === "true" || l === "1" || l === "yes") return { ok: true, value: "true" };
        if (l === "false" || l === "0" || l === "no") return { ok: true, value: "false" };
        return { ok: false, error: `Invalid boolean for ${key}` };
    }

    if (t === "number") {
        if (s === "") return { ok: true, value: "" };
        const n = Number(s);
        if (!Number.isFinite(n)) {
            return { ok: false, error: `Invalid number for ${key}` };
        }
        return { ok: true, value: String(n) };
    }

    if (t === "csv") {
        return { ok: true, value: s };
    }

    return { ok: true, value: s };
}
