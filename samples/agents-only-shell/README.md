# merrymen — review prototype

Standalone app to look at before anything is wired into `web/`.

```bash
cd samples/agents-only-shell
npm install
npm run dev
```

Open http://localhost:4173

Token prices load independently of the optional dashboard on port 3100. The Vite
`/robinhood` proxy reads the official [Stock Token APIs](https://docs.robinhood.com/chain/stock-token-apis/).
Displayed prices are bid/ask midpoints multiplied by each asset's current token
multiplier, matched by mainnet contract address. Quotes refresh every minute while
the page is visible and when returning to the tab. Failed refreshes keep the last
successful quote; hover a price to see its source and timestamp.

Session returns and candles use the existing Yahoo chart proxy. Reference returns
are cached for five minutes. Missing history stays unavailable rather than showing
generated candles. No wallet or trading service is needed for these display reads.

### Vercel static preview

Build from the repository root with `npm run build --prefix samples/agents-only-shell`, then copy `deploy/vercel.json` into `dist/vercel.json` and deploy that `dist` directory. The routing file forwards the quote and chart requests to the public upstream services. The local trading backend is not deployed with this sample; deposit and withdrawal screens remain amount/review flows.
