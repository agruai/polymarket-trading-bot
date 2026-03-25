import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { getClobClient } from "./providers/clobclient";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { config } from "./config";

import { PredictiveArbBot } from "./order-builder/predictiveArb";
import { setupConsoleFileLogging } from "./utils/console-file";
import { msUntilNextIntervalBoundary } from "./utils/marketInterval";
import { logger } from "./utils/logger";

// Capture ALL console output (stdout/stderr) into a local file.
// Configure via env var:
// - LOG_FILE_PATH="logs/bot-{date}.log" (daily) or "logs/bot.log" (single file)
// - LOG_DIR="logs" and LOG_FILE_PREFIX="bot" (daily; used if LOG_FILE_PATH not set)
setupConsoleFileLogging({
    logFilePath: config.logging.logFilePath, // supports "{date}" placeholder
    logDir: config.logging.logDir,
    filePrefix: config.logging.logFilePrefix,
});

async function waitForNextMarketStart(): Promise<void> {
    const iv = config.predictiveArb.marketIntervalMinutes;
    const ms = msUntilNextIntervalBoundary(iv);
    if (ms <= 0) return;
    logger.info(
        `Waiting for next ${iv}m market start: ${Math.ceil(ms / 1000)}s (start at next boundary)`
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    logger.info(`Next ${iv}m market started — starting bot now`);
}

async function main() {
    logger.info("Starting the bot...");

    // Create credentials if they don't exist
    const credential = await createCredential();
    if (credential) {
        logger.info("Credentials ready");
    }

    const clobClient = await getClobClient();

    // Approve USDC allowances to Polymarket contracts
    if (clobClient) {
        try {
            logger.info("Approving USDC allowances to Polymarket contracts...");
            await approveUSDCAllowance();

            // Update CLOB API to sync with on-chain allowances
            logger.info("Syncing allowances with CLOB API...");
            await updateClobBalanceAllowance(clobClient);
        } catch (error) {
            logger.error("Failed to approve USDC allowances", error);
            logger.error("Continuing without allowances - orders may fail");
        }

        // Validation gate: proceed only once available USDC balance is >= $1
        const { ok, available, allowance, balance } = await waitForMinimumUsdcBalance(clobClient, config.bot.minUsdcBalance, {
            pollIntervalMs: 15_000,
            timeoutMs: 0, // wait indefinitely
            logEveryPoll: true,
        });
        logger.info(
            `waitForMinimumUsdcBalance ==> ok=${ok} available=${available} allowance=${allowance} balance=${balance}`
        );
        logger.info("Wallet is funded");
        // Next step:
        if (config.bot.waitForNextMarketStart) {
            await waitForNextMarketStart();
        } else {
            logger.info(
                `Skipping wait for next ${config.predictiveArb.marketIntervalMinutes}m market start (resume immediately from state)`
            );
        }
        // Delay trading start to allow previous market to become redeemable (~200s) and be redeemed by worker.
        const bot = await PredictiveArbBot.fromEnv(clobClient);
        
        // Handle graceful shutdown - generate summaries before exit
        const shutdown = async (signal: string) => {
            logger.info(`\n🛑 Received ${signal}, generating final summaries...`);
            bot.stop();
            await new Promise(resolve => setTimeout(resolve, 1000)); // Give time for summaries to log
            process.exit(0);
        };
        
        process.once("SIGINT", () => void shutdown("SIGINT"));
        process.once("SIGTERM", () => void shutdown("SIGTERM"));
        
        await bot.start();
    } else {
        logger.error("Failed to initialize CLOB client - cannot continue");
        return;
    }
}

main().catch((error) => {
    logger.error("Fatal error", error);
    process.exit(1);
});
