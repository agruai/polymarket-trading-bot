import { readFileSync, existsSync } from "fs";
import { Chain, ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";
import { createCredential, ensureCredential, credentialPath } from "../security/createCredential";

function parseCredentialFile(raw: string): ApiKeyCreds {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
        key: String(j.key ?? j.apiKey ?? ""),
        secret: String(j.secret ?? ""),
        passphrase: String(j.passphrase ?? ""),
    };
}

function credentialRecordIsComplete(c: ApiKeyCreds): boolean {
    return Boolean(c.key && c.secret && c.passphrase);
}

// Cache for ClobClient instance to avoid repeated initialization
let cachedClient: ClobClient | null = null;
let cachedConfig: { chainId: number; host: string } | null = null;

/**
 * Initialize ClobClient from credentials (cached singleton).
 * If credential file is missing, creates it automatically via createOrDeriveApiKey.
 */
export async function getClobClient(): Promise<ClobClient> {
    if (!existsSync(credentialPath())) {
        const ok = await ensureCredential();
        if (!ok) {
            throw new Error(
                "Credential file not found and could not create one. Set PRIVATE_KEY and ensure the wallet can create a Polymarket API key."
            );
        }
    }

    let creds = parseCredentialFile(readFileSync(credentialPath(), "utf-8"));
    if (!credentialRecordIsComplete(creds)) {
        // Common failure: partial API response was saved — JSON.stringify omits `undefined`,
        // so `secret` never made it to disk and `.replace` on secret crashes below.
        const refreshed = await createCredential();
        if (!refreshed || !credentialRecordIsComplete(refreshed)) {
            throw new Error(
                "src/data/credential.json is missing key, secret, or passphrase. Delete it and restart, or fix CLOB_API_URL / wallet access."
            );
        }
        creds = refreshed;
    }

    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;

    // Return cached client if config hasn't changed
    if (cachedClient && cachedConfig && 
        cachedConfig.chainId === chainId && 
        cachedConfig.host === host) {
        return cachedClient;
    }

    // Create wallet from private key
    const privateKey = config.requirePrivateKey();
    const wallet = new Wallet(privateKey);

    // Convert base64url secret to standard base64 for clob-client compatibility
    const secretBase64 = creds.secret.replace(/-/g, '+').replace(/_/g, '/');

    // Create API key credentials
    const apiKeyCreds: ApiKeyCreds = {
        key: creds.key,
        secret: secretBase64,
        passphrase: creds.passphrase,
    };

    // Signature type: 0 = EOA (browser/MetaMask), 2 = proxy/smart wallet. Use EOA by default so
    // orders are signed as your wallet; only use 2 + funder when USE_PROXY_WALLET=true.
    const signatureType = config.useProxyWallet ? 2 : 0;
    const funderAddress = config.useProxyWallet ? config.prozyWalletAddress : undefined;

    // Create and cache client
    cachedClient = new ClobClient(host, chainId, wallet, apiKeyCreds, signatureType, funderAddress);
    cachedConfig = { chainId, host };

    return cachedClient;
}

/**
 * Clear cached ClobClient (useful for testing or re-initialization)
 */
export function clearClobClientCache(): void {
    cachedClient = null;
    cachedConfig = null;
}