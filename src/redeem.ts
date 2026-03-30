#!/usr/bin/env bun
/**
 * Standalone script to redeem positions for resolved markets
 * 
 * Usage:
 *   bun src/redeem.ts <conditionId|slug> [indexSets...]
 *   bun src/redeem.ts 0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1 1 2
 *   bun src/redeem.ts btc-updown-5m-1774706100
 * 
 * Or set CONDITION_ID and INDEX_SETS in .env file
 * You can also pass --slug <slug> explicitly:
 *   bun src/redeem.ts --slug btc-updown-5m-1774706100
 * 
 * Optional flags:
 *   --wait-seconds <n>       Wait and retry if no redeemable balance yet (default 0)
 *   --interval-seconds <n>   Retry interval when waiting (default 30)
 *   --pool-only              Optimize for binary pools (limits on-chain balance scan)
 *   --quiet                  Less verbose logs
 */

import { redeemPositions, redeemMarket } from "./utils/redeem";
import { getAllHoldings, getMarketHoldings } from "./utils/holdings";
import { logger } from "./utils/logger";
import { config } from "./config";
import { getUsdcBalance } from "./utils/usdcBalance";
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";
import path from "path";

async function resolveConditionIdFromSlug(slug: string): Promise<string> {
	// Gamma API: /markets/slug/:slug returns { conditionId, ... }
	const url = `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to resolve slug '${slug}': ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as any;
	const conditionId = data?.conditionId as string | undefined;
	if (!conditionId || typeof conditionId !== "string" || !conditionId.startsWith("0x")) {
		throw new Error(`Slug '${slug}' did not return a valid conditionId`);
	}
	return conditionId;
}

async function resolveConditionIdFromArg(firstArg: string, restArgs: string[]): Promise<{ conditionId?: string; indexSets?: number[] }> {
	// Support:
	//  - Direct conditionId (0x...)
	//  - Slug as first positional arg (no 0x prefix)
	//  - --slug <slug>
	//  - Optional trailing indexSets if first arg is a conditionId
	if (firstArg === "--slug") {
		const slug = restArgs[0];
		if (!slug) throw new Error("Missing value for --slug");
		const conditionId = await resolveConditionIdFromSlug(slug);
		return { conditionId, indexSets: undefined };
	}
	if (firstArg.startsWith("0x")) {
		// Only parse numeric args as indexSets; ignore flags like --wait-seconds
		const numeric = restArgs.filter(a => /^[0-9]+$/.test(a));
		const indexSets = numeric.length > 0 ? numeric.map(a => parseInt(a, 10)) : undefined;
		return { conditionId: firstArg, indexSets };
	}
	// Treat as slug when not prefixed with 0x
	const conditionId = await resolveConditionIdFromSlug(firstArg);
	return { conditionId, indexSets: undefined };
}

function pnlLogPath(): string {
    const dir = config.logging.logDir || "logs";
    return path.resolve(__dirname, "..", dir, "pnl.log");
}

function appendPnlLogLine(line: string): void {
    const p = pnlLogPath();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    } catch (e) {
        logger.error(`Failed to append pnl.log: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function parseFlags(args: string[]): { waitSeconds: number; intervalSeconds: number; poolOnly: boolean; quiet: boolean } {
	let waitSeconds = 0;
	let intervalSeconds = 30;
	let poolOnly = false;
	let quiet = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--wait-seconds" && i + 1 < args.length) {
			const v = parseInt(args[i + 1], 10);
			if (Number.isFinite(v) && v >= 0) waitSeconds = v;
			i++;
		} else if (a === "--interval-seconds" && i + 1 < args.length) {
			const v = parseInt(args[i + 1], 10);
			if (Number.isFinite(v) && v > 0) intervalSeconds = v;
			i++;
		} else if (a === "--pool-only") {
			poolOnly = true;
		} else if (a === "--quiet") {
			quiet = true;
		}
	}
	return { waitSeconds, intervalSeconds, poolOnly, quiet };
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const args = process.argv.slice(2);
	const { waitSeconds, intervalSeconds, poolOnly, quiet } = parseFlags(args);

    // Get condition ID from args or env
    let conditionId: string | undefined;
    let indexSets: number[] | undefined;

	if (args.length > 0) {
		try {
			const { conditionId: cid, indexSets: idx } = await resolveConditionIdFromArg(args[0], args.slice(1));
			conditionId = cid;
			indexSets = idx;
		} catch (e) {
			logger.error(e instanceof Error ? e.message : String(e));
			process.exit(1);
		}
	} else {
        conditionId = config.redeem.conditionId;
        const indexSetsEnv = config.redeem.indexSets;
        if (indexSetsEnv) {
            indexSets = indexSetsEnv.split(",").map(s => parseInt(s.trim(), 10));
        }
    }

    // If no conditionId provided, show holdings and prompt
    if (!conditionId) {
        logger.info("No condition ID provided. Showing current holdings...");
        const holdings = getAllHoldings();
        
        if (Object.keys(holdings).length === 0) {
            logger.error("No holdings found.");
            logger.info("\nUsage:");
			logger.info("  bun src/redeem.ts <conditionId|slug> [indexSets...]");
			logger.info("  bun src/redeem.ts 0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1 1 2");
			logger.info("  bun src/redeem.ts btc-updown-5m-1774706100");
			logger.info("  bun src/redeem.ts --slug btc-updown-5m-1774706100");
            logger.info("\nOr set in .env:");
            logger.info("  CONDITION_ID=0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1");
            logger.info("  INDEX_SETS=1,2");
            process.exit(1);
        }

        logger.info("\nCurrent Holdings:");
        for (const [marketId, tokens] of Object.entries(holdings)) {
            logger.info(`  Market: ${marketId}`);
            for (const [tokenId, amount] of Object.entries(tokens)) {
                logger.info(`    Token ${tokenId.substring(0, 20)}...: ${amount}`);
            }
        }
        logger.info("\nTo redeem a market, provide the conditionId (market ID) as an argument.");
		logger.info("Examples:");
		logger.info("  bun src/redeem.ts <conditionId>");
		logger.info("  bun src/redeem.ts <slug>");
		logger.info("  bun src/redeem.ts --slug <slug>");
        process.exit(0);
    }

    // Default to [1, 2] for Polymarket binary markets if not specified
    if (!indexSets || indexSets.length === 0) {
        logger.info("No index sets specified, using default [1, 2] for Polymarket binary markets");
        indexSets = [1, 2];
    }

    // Show holdings for this market if available
    const marketHoldings = getMarketHoldings(conditionId);
    if (Object.keys(marketHoldings).length > 0) {
        logger.info(`\nHoldings for market ${conditionId}:`);
        for (const [tokenId, amount] of Object.entries(marketHoldings)) {
            logger.info(`  Token ${tokenId.substring(0, 20)}...: ${amount}`);
        }
    } else {
        logger.error(`No holdings found for market ${conditionId}`);
    }

    try {
        logger.info(`\nRedeeming positions for condition: ${conditionId}`);
        logger.info(`Index Sets: ${indexSets.join(", ")}`);

		const deadlineMs = Date.now() + waitSeconds * 1000;
		let attempt = 0;
		let receipt: any | null = null;
		// Attempt redeem; if “no tokens to redeem”, optionally wait and retry
		// Uses poolOnly to limit on-chain scan to binary indexSets when requested.
		while (true) {
			attempt++;
			try {
				receipt = await redeemMarket(conditionId, undefined, 3, {
					quiet,
					poolRedeemOnly: poolOnly,
				});
				break;
			} catch (err: any) {
				const msg = (err && (err.message || err.reason)) ? String(err.message || err.reason) : String(err);
				const noTokens = msg.toLowerCase().includes("don't have any tokens") || msg.toLowerCase().includes("do not have any tokens");
				if (noTokens && Date.now() < deadlineMs) {
					const remaining = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
					logger.info(`No redeemable tokens detected yet (attempt ${attempt}). Waiting ${intervalSeconds}s... (${remaining}s left)`);
					await sleep(intervalSeconds * 1000);
					continue;
				}
				throw err;
			}
		}

        logger.info("\n✅ Successfully redeemed positions!");
        logger.info(`Transaction hash: ${receipt.transactionHash}`);
        logger.info(`Block number: ${receipt.blockNumber}`);
        logger.info(`Gas used: ${receipt.gasUsed.toString()}`);

        // Get wallet balance after redemption and log to pnl.log
        try {
            const privateKey = config.requirePrivateKey();
            const wallet = new Wallet(privateKey);
            const walletAddress = await wallet.getAddress();
            
            try {
                const balanceAfterRedeem = await getUsdcBalance(walletAddress);
                logger.info(`Wallet balance after redeem: ${balanceAfterRedeem.toFixed(6)} USDC`);
                
                // Log to pnl.log
                const logLine = `${new Date().toISOString()} slug=? market=? conditionId=${conditionId} pnl=? cost=? payout=? note=redeemed balance=${balanceAfterRedeem.toFixed(6)}`;
                appendPnlLogLine(logLine);
                logger.info(`✅ Logged balance to pnl.log`);
            } catch (balanceError) {
                logger.error(`Failed to get balance after redeem: ${balanceError instanceof Error ? balanceError.message : String(balanceError)}`);
                // Still log to pnl.log without balance
                const logLine = `${new Date().toISOString()} slug=? market=? conditionId=${conditionId} pnl=? cost=? payout=? note=redeemed`;
                appendPnlLogLine(logLine);
            }
        } catch (balanceLogError) {
            logger.error(`Failed to log balance: ${balanceLogError instanceof Error ? balanceLogError.message : String(balanceLogError)}`);
        }

        // Automatically clear holdings after successful redemption
        try {
            const { clearMarketHoldings } = await import("./utils/holdings");
            clearMarketHoldings(conditionId);
            logger.info(`\n✅ Cleared holdings record for this market from token-holding.json`);
        } catch (clearError) {
            logger.error(`Failed to clear holdings: ${clearError instanceof Error ? clearError.message : String(clearError)}`);
            // Don't fail if clearing holdings fails
        }
    } catch (error) {
        logger.error("\n❌ Failed to redeem positions:", error);
        if (error instanceof Error) {
            logger.error(`Error message: ${error.message}`);
        }
        process.exit(1);
    }
}

main().catch((error) => {
    logger.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});

