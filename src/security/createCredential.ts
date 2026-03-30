import { ApiKeyCreds, ClobClient, Chain } from "@polymarket/clob-client";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { Wallet } from "@ethersproject/wallet";
import { logger } from "../utils/logger";
import { config } from "../config";

const CREDENTIAL_PATH = resolve(process.cwd(), "src/data/credential.json");

export function credentialPath(): string {
    return CREDENTIAL_PATH;
}

export function hasCredentialFile(): boolean {
    return existsSync(CREDENTIAL_PATH);
}

function isCompleteApiKeyCreds(c: ApiKeyCreds | null | undefined): boolean {
    return Boolean(
        c &&
            typeof c.key === "string" &&
            c.key.length > 0 &&
            typeof c.secret === "string" &&
            c.secret.length > 0 &&
            typeof c.passphrase === "string" &&
            c.passphrase.length > 0
    );
}

/**
 * Polymarket may return a partial object from createApiKey (e.g. key set but secret missing).
 * createOrDeriveApiKey only falls back to derive when `!response.key`, not when secret is absent.
 * We explicitly recover via deriveApiKey so credential.json always contains a full triple.
 */
async function fetchCompleteApiKeyCreds(clobClient: ClobClient): Promise<ApiKeyCreds> {
    let credential = await clobClient.createOrDeriveApiKey();
    if (isCompleteApiKeyCreds(credential)) return credential;

    logger.warning("API key response was incomplete; trying deriveApiKey()…");
    credential = await clobClient.deriveApiKey();
    if (isCompleteApiKeyCreds(credential)) return credential;

    logger.warning("deriveApiKey still incomplete; trying createApiKey()…");
    credential = await clobClient.createApiKey();
    if (isCompleteApiKeyCreds(credential)) return credential;

    throw new Error(
        "Polymarket did not return a complete API key (key, secret, passphrase). Check network / CLOB_API_URL and try again."
    );
}

/**
 * Create API key credentials via createOrDeriveApiKey and save to src/data/credential.json.
 * Ensures src/data directory exists before writing.
 */
export async function createCredential(): Promise<ApiKeyCreds | null> {
    const privateKey = config.privateKey;
    if (!privateKey) return (logger.error("PRIVATE_KEY not found"), null);

    try {
        const wallet = new Wallet(privateKey);
        logger.info(`wallet address ${wallet.address}`);
        const chainId = (config.chainId || Chain.POLYGON) as Chain;
        const host = config.clobApiUrl;

        // Create temporary ClobClient (no API key) and derive/create API key
        const clobClient = new ClobClient(host, chainId, wallet);
        const credential = await fetchCompleteApiKeyCreds(clobClient);
        await saveCredential(credential);

        logger.info("Credential created successfully");
        return credential;
    } catch (error) {
        logger.error("createCredential error", error);
        logger.error(
            `Error creating credential: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

export async function saveCredential(credential: ApiKeyCreds): Promise<void> {
    const dir = dirname(CREDENTIAL_PATH);
    mkdirSync(dir, { recursive: true });
    writeFileSync(CREDENTIAL_PATH, JSON.stringify(credential, null, 2));
}

/**
 * Ensure credential file exists: create via createOrDeriveApiKey if missing.
 * Returns true if credentials are available (existing or newly created), false otherwise.
 */
export async function ensureCredential(): Promise<boolean> {
    if (hasCredentialFile()) return true;
    const credential = await createCredential();
    return credential !== null;
}