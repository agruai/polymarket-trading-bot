import { Wallet } from "ethers";
import { POLYMARKET_PRIVATE_KEY, PROXY_WALLET_ADDRESS } from "../config";

export const HOST = "https://clob.polymarket.com";
export const CHAIN_ID = 137;

// Wrap ethers v6 Wallet so @polymarket/clob-client can use it
export const SIGNER = Object.assign(new Wallet(POLYMARKET_PRIVATE_KEY), {
  // clob-client expects _signTypedData (ethers v5-style); delegate to v6 signTypedData
  _signTypedData(domain: any, types: any, value: any) {
    return (this as any).signTypedData(domain, types, value);
  },
  // Some versions also look for a viem-style walletClient with account.address
  walletClient: {
    account: {
      address: new Wallet(POLYMARKET_PRIVATE_KEY).address,
    },
  },
});

// For proxy wallets (Gnosis Safe), FUNDER must be the proxy contract address
// SIGNER is the EOA that signs, FUNDER is the proxy wallet that holds funds
export const FUNDER = PROXY_WALLET_ADDRESS;

export const SIGNATURE_TYPE = 2; // 2 = Gnosis Safe / Proxy wallet (0 = EOA, 1 = EIP-1271, 2 = Gnosis Safe)


export const getPrices = async (upTokenId: string, downTokenId: string) => {
    const response = await fetch("https://clob.polymarket.com/prices", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify([
            {
                token_id: upTokenId,
                side: "BUY",
            },
            {
                token_id: upTokenId,
                side: "SELL",
            },
            {
                token_id: downTokenId,
                side: "BUY",
            },
            {
                token_id: downTokenId,
                side: "SELL",
            },
        ]),
    });
    const prices = await response.json();
    return prices;
}