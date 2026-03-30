/**
 * Simple local config UI for editing .env.
 * Run: npm run config-ui
 * Open: http://127.0.0.1:3847 (default; set CONFIG_UI_PORT)
 * Optional: CONFIG_UI_TOKEN — require Authorization: Bearer <token>
 */

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { BOT_LIVE_STATUS_PATH } from "../utils/botLiveStatus";
import { CONFIG_SCHEMA, ALL_SCHEMA_KEYS, SENSITIVE_KEYS } from "./configSchema";
import { mergeEnvWithStaticDefaults } from "./defaultEnvValues";
import { parseEnvFile, writeEnvFile, validateValue, envPath } from "./envFile";
import { readTailBytes, resolveLogFilePathFromEnv } from "./logResolve";
import { getBotProcessStatus, startBotFromUi, stopBotFromUi } from "./botProcess";

const PORT = Number(process.env.CONFIG_UI_PORT) || 3847;
const HOST = process.env.CONFIG_UI_HOST || "127.0.0.1";
const TOKEN = process.env.CONFIG_UI_TOKEN?.trim() || "";

function htmlPath(): string {
    return path.resolve(process.cwd(), "src/config-ui/index.html");
}

function readEnvValues(): Record<string, string> {
    try {
        const raw = fs.readFileSync(envPath(), "utf8");
        return parseEnvFile(raw);
    } catch {
        return {};
    }
}

function maskForResponse(values: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...values };
    for (const k of SENSITIVE_KEYS) {
        if (out[k] && out[k].length > 0) {
            out[k] = "********";
        }
    }
    return out;
}

function checkAuth(req: http.IncomingMessage): boolean {
    if (!TOKEN) return true;
    const auth = req.headers.authorization;
    if (auth === `Bearer ${TOKEN}`) return true;
    return false;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(data);
}

function sendText(res: http.ServerResponse, status: number, body: string, type = "text/plain"): void {
    res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
    res.end(body);
}

const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] || "/";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Cache-Control");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    if (url === "/" || url === "/index.html") {
        try {
            const html = fs.readFileSync(htmlPath(), "utf8");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html);
        } catch (e) {
            sendText(res, 500, `Missing index.html: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
    }

    if (url === "/api/schema" && req.method === "GET") {
        sendJson(res, 200, { schema: CONFIG_SCHEMA, authRequired: Boolean(TOKEN) });
        return;
    }

    if (url === "/api/config" && req.method === "GET") {
        const fileValues = readEnvValues();
        const values = mergeEnvWithStaticDefaults(fileValues);
        sendJson(res, 200, {
            values: maskForResponse(values),
            envPath: envPath(),
        });
        return;
    }

    if (url === "/api/bot/control" && req.method === "GET") {
        sendJson(res, 200, getBotProcessStatus());
        return;
    }

    if (url === "/api/bot/start" && req.method === "POST") {
        if (!checkAuth(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        const result = startBotFromUi();
        sendJson(res, result.ok ? 200 : 409, result);
        return;
    }

    if (url === "/api/bot/stop" && req.method === "POST") {
        if (!checkAuth(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        const result = stopBotFromUi();
        sendJson(res, result.ok ? 200 : 400, result);
        return;
    }

    if (url === "/api/bot-status" && req.method === "GET") {
        try {
            if (fs.existsSync(BOT_LIVE_STATUS_PATH)) {
                const raw = fs.readFileSync(BOT_LIVE_STATUS_PATH, "utf8");
                const data = JSON.parse(raw) as unknown;
                sendJson(res, 200, { ok: true, status: data, path: BOT_LIVE_STATUS_PATH });
            } else {
                sendJson(res, 200, {
                    ok: false,
                    offline: true,
                    message: "No live status file yet — start the trading bot (npm start) to populate pool prices.",
                    path: BOT_LIVE_STATUS_PATH,
                });
            }
        } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
    }

    if (url === "/api/logs/stream" && req.method === "GET") {
        const logPath = resolveLogFilePathFromEnv();
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        res.write("\n");

        let lastPath = logPath ?? "";
        let position = 0;

        const sendInit = () => {
            const p = resolveLogFilePathFromEnv();
            lastPath = p ?? "";
            if (!p || !fs.existsSync(p)) {
                res.write(
                    `data: ${JSON.stringify({ type: "init", text: "", logPath: p ?? null })}\n\n`
                );
                position = 0;
                return;
            }
            const st = fs.statSync(p);
            position = st.size;
            const tail = readTailBytes(p, 65536);
            res.write(`data: ${JSON.stringify({ type: "init", text: tail, logPath: p })}\n\n`);
        };

        sendInit();

        const tick = (): void => {
            if (res.writableEnded) return;
            try {
                const p = resolveLogFilePathFromEnv();
                if (!p || !fs.existsSync(p)) return;

                if (p !== lastPath) {
                    lastPath = p;
                    position = 0;
                    const st = fs.statSync(p);
                    const tail = readTailBytes(p, 65536);
                    position = st.size;
                    res.write(`data: ${JSON.stringify({ type: "init", text: tail, logPath: p, rotated: true })}\n\n`);
                    return;
                }

                const st = fs.statSync(p);
                if (st.size < position) {
                    position = 0;
                }
                if (st.size > position) {
                    const fd = fs.openSync(p, "r");
                    try {
                        const len = st.size - position;
                        const buf = Buffer.alloc(len);
                        fs.readSync(fd, buf, 0, len, position);
                        position = st.size;
                        res.write(`data: ${JSON.stringify({ type: "chunk", text: buf.toString("utf8") })}\n\n`);
                    } finally {
                        fs.closeSync(fd);
                    }
                }
            } catch {
                // ignore
            }
        };

        const iv = setInterval(tick, 500);
        const keep = setInterval(() => {
            if (!res.writableEnded) res.write(": ping\n\n");
        }, 25000);

        req.on("close", () => {
            clearInterval(iv);
            clearInterval(keep);
        });
        return;
    }

    if (url === "/api/config" && req.method === "POST") {
        if (!checkAuth(req)) {
            sendJson(res, 401, { error: "Unauthorized" });
            return;
        }
        let body = "";
        req.on("data", (c) => {
            body += c;
            if (body.length > 2_000_000) req.destroy();
        });
        req.on("end", () => {
            try {
                const parsed = JSON.parse(body) as { values?: Record<string, string> };
                const incoming = parsed.values ?? {};
                const current = readEnvValues();
                const merged: Record<string, string> = { ...current };

                for (const key of ALL_SCHEMA_KEYS) {
                    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
                    let raw = incoming[key];
                    if (typeof raw !== "string") raw = String(raw ?? "");
                    if (SENSITIVE_KEYS.has(key) && (raw === "********" || raw === "")) {
                        continue;
                    }
                    const v = validateValue(key, raw);
                    if (!v.ok) {
                        sendJson(res, 400, { error: v.error });
                        return;
                    }
                    if (v.value !== "") {
                        merged[key] = v.value;
                    } else if (!SENSITIVE_KEYS.has(key)) {
                        delete merged[key];
                    }
                }

                const result = writeEnvFile(merged);
                if (!result.written) {
                    sendJson(res, 500, { error: result.error ?? "Write failed" });
                    return;
                }
                sendJson(res, 200, { ok: true, savedTo: envPath() });
            } catch (e) {
                sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
        });
        return;
    }

    sendText(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Config UI: http://${HOST}:${PORT}/`);
    if (TOKEN) {
        // eslint-disable-next-line no-console
        console.log("Auth: set Authorization: Bearer <CONFIG_UI_TOKEN>");
    } else {
        // eslint-disable-next-line no-console
        console.log("Listening on localhost only. Set CONFIG_UI_TOKEN to require a bearer token.");
    }
});
