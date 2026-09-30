# Autonomous Trencher permission

Status: implementation under verification; no production factory is configured by this change. The isolated mainnet-fork buy/sell test against the real V3 router passed. This is not a live Shogun or account UserOperation result.

The existing key names each tradable token. Autonomous Trencher instead authorizes an owner-specific vault to buy and sell tokens from verified Uniswap v3 pools. The vault owns purchased tokens, grants exact temporary router allowances, and sends sale proceeds only to the owner's smart account. The session cannot call recovery or choose a recipient. The owner can recover tokens separately.

Discovery ranks active volume pools and verifies their token pair and factory provenance on-chain. It does not require custom tokens. The first version supports direct USDG routes and USDG/WETH/token routes, not v4 or ungraduated bonding curves. A valid pool and high reported volume do not establish that a token is safe or profitable.

Fast mode requires a fresh Brain buy approval, checks exits every configured 15-second tick, and prioritizes exits. Its existing thresholds are −10%, +20%, 30 minutes, and liquidity deterioration. These are decision thresholds, not guaranteed execution prices. RPC, model, bundler, liquidity and token restrictions can prevent fills.

The vault caps each buy at 5 USDG and total buys at 25 USDG per contract 24-hour window, beginning with a buy after the previous window expires. Lower signed per-trade limits and worker limits still apply. The 24-hour contract window is not a continuously trailing window. Reaching its entry limit does not disable vault sells. Grant expiry, chain failure or an unsellable token can still block exits.

## Release steps

1. Run root typecheck and tests, the contract suite, and contract deployment-script typecheck. Review contract and session permissions together. Run a fork test against the actual router and the account's UserOperation path before declaring live execution verified; mock-router tests do not prove this.
2. An operator with a deployment signer runs `node --import tsx node_modules/hardhat/internal/cli/cli.js run scripts/deploy-trenchervault.ts --network robinhood` from `contracts`. Preflight requires `MERRYMEN_DEPLOYER_PRIVATE_KEY`; actual deployment additionally requires `TRENCHER_DEPLOY=1`. Never use a user's session key or expose a private key in logs.
3. Verify deployed source and runtime against the reviewed build. Save the generated `trencher-deployment.json` manifest. Set web build variables `NEXT_PUBLIC_TRENCHER_FACTORY` and `NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH`, and worker `TRENCHER_FACTORY_CODE_HASH` to that verified deployment. These are public identifiers, not secrets. Rebuild the web service.
4. The owner opens trading permission, selects Autonomous Trencher, checks the limits, and signs the renewal. This does not enable live trading. Existing vault positions must be closed or recovered before removing/changing the permission.
5. The owner selects Trencher, Crypto or All assets, fast exits, connects Brain, and explicitly enables live trading and the separate live Trencher switch. Native gas, an unexpired key and complete accounting are required.
6. For Shogun, the owner performs signing and live activation. Inspect one discovered candidate, its Brain decision, confirmed buy receipt, vault balance, accounting, confirmed sell receipt, returned USDG and realized P&L. A hold/refusal is a valid decision, but does not constitute proof of a successful buy/sell. Do not force a real-money trade just to make the check pass.

The application refuses an unconfigured or mismatched factory runtime hash. Old grants receive no new permissions automatically. Disabling new entries is a settings action; deleting permissions while funds remain in the vault is not the recommended stop control.
