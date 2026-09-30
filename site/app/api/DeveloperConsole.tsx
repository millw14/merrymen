"use client";

import { useEffect, useState } from "react";

const BASE = "https://ai.merrymen.dev/partner/v1";
const SDK = "https://app.merrymen.dev/sdk/merrymen-browser.js";
type Key = { key_id: string; app_id: string; name: string; status: string; scopes: string[]; rate_per_min: number; created_at: string; prefix: string };
type Wallet = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type Challenge = { challenge: string; message: string };

async function request(action: string, body?: unknown) {
  const response = await fetch(`/api/developer/${action}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || "Something went wrong. Please try again."), { status: response.status });
  return data;
}
function Code({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="dev-code"><button type="button" aria-label={label} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); setTimeout(() => setCopied(false), 2000); } catch { setFailed(true); } }}>{copied ? "Copied ✓" : failed ? "Select code to copy" : "Copy ↗"}</button><pre><code>{text}</code></pre></div>;
}
const endpoints = [
  ["POST", "/agents", "Create a user's agent connection", "write:agents"],
  ["POST", "/agents/{id}/challenge", "Request wallet authorization", "write:agents"],
  ["POST", "/agents/{id}/activate", "Install permissions & start the worker", "write:agents"],
  ["GET", "/agents/{id}", "Read actual worker status", "read:agents"],
  ["POST", "/agents/{id}/messages", "Send a message to the agent", "chat:agents"],
  ["GET", "/agents/{id}/messages", "Read conversation history", "chat:agents"],
  ["DELETE", "/agents/{id}/connection", "Disconnect your app", "write:agents"],
];

export function DeveloperConsole() {
  const [address, setAddress] = useState("");
  const [keys, setKeys] = useState<Key[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<(Key & { key: string }) | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const [rotateApp, setRotateApp] = useState("");
  const [manualAddress, setManualAddress] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [signature, setSignature] = useState("");
  const [tutorial, setTutorial] = useState("quickstart");
  const [example, setExample] = useState("Node.js");
  async function refresh() {
    const data = await request("keys"); setAddress(data.address); setKeys(data.keys);
  }
  useEffect(() => { let active = true; request("keys").then(data => { if (active) { setAddress(data.address); setKeys(data.keys); } }).catch(e => { if (active && e.status !== 401) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function run(task: string, fn: () => Promise<void>) { setBusy(task); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(""); } }
  async function connect() {
    await run("connect", async () => {
      const provider = (window as Window & { ethereum?: Wallet }).ethereum;
      if (!provider) throw new Error("No browser wallet found. Open this page in your wallet browser, or use the wallet-signature option below.");
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts[0]) throw new Error("Choose an account in your wallet.");
      const proof = await request("challenge", { address: accounts[0] });
      const encoded = "0x" + [...new TextEncoder().encode(proof.message)].map(b => b.toString(16).padStart(2, "0")).join("");
      const sig = await provider.request({ method: "personal_sign", params: [encoded, accounts[0]] });
      await request("verify", { challenge: proof.challenge, signature: sig }); await refresh();
    });
  }
  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    await run("create", async () => { const data = await request("keys", { name, ...(rotateApp ? { app_id: rotateApp } : {}) }); setFresh(data); setShowKey(false); setCopiedKey(false); setTestResult(""); setName(""); setRotateApp(""); await refresh(); });
  }
  const selectedApp = fresh?.app_id || keys.find(k => k.status === "active")?.app_id || "YOUR_APP_ID";
  const backend = `// Your backend only. Never put this key in browser code.\nconst API = "${BASE}";\n\nasync function merrymen(path, body) {\n  const response = await fetch(API + path, {\n    method: body === undefined ? "GET" : "POST",\n    headers: {\n      Authorization: \`Bearer \${process.env.MERRYMEN_API_KEY}\`,\n      "Content-Type": "application/json",\n    },\n    ...(body === undefined ? {} : { body: JSON.stringify(body) }),\n  });\n  const data = await response.json();\n  if (!response.ok) throw new Error(data.error?.message || "API error");\n  return data;\n}\n\n// Get this ID from YOUR authenticated session.\nconst agent = await merrymen("/agents", {\n  external_user_id: currentUser.id,\n  name: "Robin",\n});`;
  const curl = `curl "${BASE}/meta" \\\n  -H "Authorization: Bearer $MERRYMEN_API_KEY"\n\n# Create a connection from your backend\ncurl "${BASE}/agents" \\\n  -H "Authorization: Bearer $MERRYMEN_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"external_user_id":"usr_123","name":"Robin"}'`;
  const browser = `// Browser ESM, or download and import your own pinned copy.\nimport { prepareMerryman, partnerGrantDigest,\n  signMerrymanAuthorization } from "${SDK}";\n\nconst settings = { name: "Robin", strategy: "steady-basket",\n  basket_symbols: ["AAPL", "MSFT"], live_trading_enabled: false };\n\n// owner: a viem LocalAccount-compatible signer from your wallet.\n// Show these limits and get the user's agreement before signing.\nconst grant = await prepareMerryman({ owner, chainId: 4663,\n  caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7,\n    maxDrawdownPct: 5, maxOpsPerDay: 24 } });\n\n// backend is YOUR authenticated API adapter, not this SDK.\nconst challenge = await backend.challenge(agent.id, {\n  owner: grant.owner, smart_account: grant.smartAccount,\n  chain_id: grant.chainId, grant_hash: partnerGrantDigest(grant),\n  settings,\n});\nconst authorization = await signMerrymanAuthorization({\n  owner, grant, challenge, settings,\n  expectedAppId: "${selectedApp}",\n  expectedAgentId: agent.id,\n  expectedExternalUserId: currentUser.id,\n  expectedScopes: ["read:agents", "chat:agents"],\n});\nawait backend.activate(agent.id, authorization);`;
  const chat = `// Your backend: verify this agent belongs to the signed-in user.\nconst status = await merrymen(\`/agents/\${agent.id}\`);\n\nconst answer = await merrymen(\`/agents/\${agent.id}/messages\`, {\n  message: "How is my portfolio doing?",\n  request_id: crypto.randomUUID(),\n});\nconsole.log(answer.reply);\n\nconst history = await merrymen(\`/agents/\${agent.id}/messages\`);`;
  return <main className="dev-page">
    <div className="dev-topline"><span><i /> MERRYMEN / DEVELOPERS</span><a href="#quickstart">API v1 <span aria-hidden>↗</span></a></div>
    <section className="dev-hero">
      <div><p className="dev-eyebrow">YOUR APP. THEIR MERRYMAN.</p><h1>Give your app<br />an <em>agent of its own.</em></h1><p className="dev-intro">Create agents. Set their limits. Start a conversation.<br />One API, with the entire setup inside your app.</p><div className="dev-hero-actions"><a className="dev-primary" href="#api-keys">Get your API key <span>↗</span></a><a className="dev-textlink" href="/api/developer/sdk">Download browser SDK ↓</a></div><div className="dev-facts"><span>Wallet-owned agents</span><span>On-chain permission limits</span><span>Built-in chat</span></div></div>
      <div className="dev-terminal" aria-label="Example API request and response"><div className="dev-terminal-head"><span><b /> <b /> <b /></span><span>your-app / server.ts</span><small>REST API</small></div><pre><span className="dev-muted">// Your interface. Their agent.</span>{"\n"}<span className="dev-purple">const</span>{" agent = "}<span className="dev-purple">await</span>{" merrymen("}{"\n  "}<span className="dev-lime">"/agents"</span>{", {"}{"\n    external_user_id: "}<span className="dev-lime">"usr_123"</span>{","}{"\n    name: "}<span className="dev-lime">"Robin"</span>{"\n  });"}</pre><div className="dev-terminal-response"><span className="dev-badge">202 ACCEPTED · EXAMPLE</span><pre>{'{\n  "id": "pa_…",\n  "status": "pending_authorization"\n}'}</pre><p>The owner signs. Merrymen runs the worker.</p></div></div>
    </section>
    <div className="dev-workspace">
      <aside className="dev-sidebar"><p>BUILD WITH MERRYMEN</p><a href="#api-keys">01 <span>API keys</span> ↗</a><a href="#quickstart">02 <span>Quickstart</span></a><a href="#reference">03 <span>API reference</span></a><a href="#essentials">04 <span>Good to know</span></a><div className="dev-sidebar-note"><span>BASE URL</span><code>ai.merrymen.dev<br />/partner/v1</code><a href={`${BASE}/health`} target="_blank" rel="noreferrer">Check API health ↗</a></div></aside>
      <div className="dev-content">
        <section id="api-keys" className="dev-section"><div className="dev-section-heading"><div><p className="dev-eyebrow">01 / YOUR WORKSPACE</p><h2>Keys to your next idea.</h2></div><span className="dev-pill">SERVER-SIDE ONLY</span></div><p className="dev-description">Give each app its own key. User wallets stay in their control.</p>
          {loading ? <div className="dev-account-box" role="status">Loading your developer account…</div> : !address ? <div className="dev-account-box"><div className="dev-lock" aria-hidden>⌘</div><div><h3>Your wallet is your developer account.</h3><p>Sign a message to create and manage API keys. No payment, transaction, or token balance required.</p></div><button className="dev-primary" disabled={!!busy} onClick={connect}>{busy === "connect" ? "Check your wallet…" : "Connect wallet ↗"}</button>
            <details className="dev-manual"><summary>Use a wallet signature instead</summary><p>For wallets without a browser connection: request the message, sign it using your wallet’s personal-message signing tool, and paste the signature. Never paste a private key.</p><form onSubmit={e => { e.preventDefault(); void run("challenge", async () => { setChallenge(await request("challenge", { address: manualAddress })); setSignature(""); }); }}><label>Wallet address<input required value={manualAddress} onChange={e => setManualAddress(e.target.value)} placeholder="0x…" pattern="0x[a-fA-F0-9]{40}" /></label><button className="dev-secondary" disabled={!!busy}>Get sign-in message</button></form>{challenge && <><Code text={challenge.message} label="Copy sign-in message" /><form onSubmit={e => { e.preventDefault(); void run("verify", async () => { await request("verify", { challenge: challenge.challenge, signature }); setSignature(""); setChallenge(null); await refresh(); }); }}><label>Wallet signature<input required type="password" autoComplete="off" value={signature} onChange={e => setSignature(e.target.value)} placeholder="0x…" /></label><button className="dev-primary" disabled={!!busy}>Verify signature</button></form></>}</details>
          </div> : <div className="dev-key-workspace"><div className="dev-account-bar"><span><i /> Connected <code>{address.slice(0, 6)}…{address.slice(-4)}</code></span><button onClick={() => run("logout", async () => { await request("logout", {}); setAddress(""); setKeys([]); setFresh(null); setRevokeId(""); setRotateApp(""); setTestResult(""); })} disabled={!!busy}>Sign out</button></div>
            <form className="dev-create-form" onSubmit={createKey}><label>{rotateApp ? "New key for this app" : "Application name"}<input required maxLength={48} placeholder="e.g. Prism Finance" value={name} onChange={e => setName(e.target.value)} /></label><button className="dev-primary" disabled={!!busy || !name.trim()}>{busy === "create" ? "Creating…" : rotateApp ? "Create replacement ↗" : "Create API key ↗"}</button>{rotateApp && <button type="button" className="dev-textlink" onClick={() => { setRotateApp(""); setName(""); }}>Cancel replacement</button>}</form>
            <p className="dev-small">Up to 5 active keys · 30 requests/minute per key · Create, read and chat scopes</p>
            {fresh && <div className="dev-new-key"><div className="dev-key-title"><strong>Your key is ready.</strong><span>SHOWN ONCE</span></div><p>Copy it into your backend’s secret storage now. We cannot show it again after you leave.</p><div className="dev-secret-row"><input aria-label="New API key" type={showKey ? "text" : "password"} readOnly value={fresh.key} autoComplete="off" spellCheck={false} /><button aria-label={showKey ? "Hide API key" : "Reveal API key"} onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Reveal"}</button><button onClick={() => run("copy", async () => { await navigator.clipboard.writeText(fresh.key); setCopiedKey(true); })}>{copiedKey ? "Copied ✓" : "Copy key"}</button></div><p className="dev-app-id">App ID <code>{fresh.app_id}</code></p><div className="dev-key-test"><button className="dev-secondary" disabled={!!busy} onClick={() => run("test", async () => { setTestResult(""); const result = await request("test", { key: fresh.key }); setTestResult(`200 OK · ${result.name} · ${result.rate_per_min} requests/minute`); })}>{busy === "test" ? "Testing…" : "Test this key ↗"}</button><span role="status">{testResult || "Makes a real authenticated /meta request."}</span></div></div>}
            <div className="dev-keys-list">{keys.length === 0 ? <p className="dev-empty">No keys yet. Your first app starts above.</p> : keys.map(key => <div className="dev-key-row" key={key.key_id}><div><strong>{key.name}</strong><code>{key.prefix}••••••••</code><small>App: {key.app_id}</small></div><span className={`dev-key-status ${key.status}`}>{key.status}</span>{key.status === "active" && <div className="dev-key-controls">{revokeId === key.key_id ? <><span>Revoke this key?</span><button className="dev-danger" disabled={!!busy} onClick={() => run("revoke", async () => { await request("revoke", { key_id: key.key_id }); if (fresh?.key_id === key.key_id) { setFresh(null); setTestResult(""); } setRevokeId(""); await refresh(); })}>Yes, revoke</button><button onClick={() => setRevokeId("")}>Cancel</button></> : <><button disabled={!!busy} onClick={() => { setRotateApp(key.app_id); setName(key.name); }}>Replace</button><button disabled={!!busy} onClick={() => setRevokeId(key.key_id)}>Revoke</button></>}</div>}</div>)}</div>
          </div>}
          {error && <p className="dev-error" role="alert">{error}</p>}
        </section>
        <section id="quickstart" className="dev-section"><p className="dev-eyebrow">02 / FROM ZERO TO FIRST CONVERSATION</p><h2>A few calls. A whole Merryman.</h2><p className="dev-description">Your backend holds the key. Your user signs the permissions. We run the agent.</p><div className="dev-tabs" role="tablist" aria-label="Integration tutorial">{[["quickstart", "1. Connect"], ["authorize", "2. Authorize"], ["chat", "3. Chat"]].map(([id, title]) => <button role="tab" aria-selected={tutorial === id} aria-controls={`tutorial-${id}`} id={`tab-${id}`} key={id} onClick={() => setTutorial(id)}>{title}</button>)}</div>
          <div className="dev-tutorial" role="tabpanel" id={`tutorial-${tutorial}`} aria-labelledby={`tab-${tutorial}`}>
            {tutorial === "quickstart" && <><h3>Create your first connection</h3><p>Save your key as <code>MERRYMEN_API_KEY</code> on your server. Create a connection for a user who is signed in to your app. A <code>pending_authorization</code> response means they still need to approve wallet permissions.</p><div className="dev-language" aria-label="Code language">{["Node.js", "cURL"].map(item => <button aria-pressed={example === item} onClick={() => setExample(item)} key={item}>{item}</button>)}</div><Code text={example === "Node.js" ? backend : curl} /></>}
            {tutorial === "authorize" && <><h3>Keep wallet setup inside your app</h3><p>Use the <a href="/api/developer/sdk">browser SDK ↓</a> with your wallet provider’s viem-compatible signer. Show the limits and request user consent. This example starts with paper trading.</p><Code text={browser} /><div className="dev-callout"><strong>Wire up your own backend adapter</strong><p><code>backend.challenge(id, body)</code> → <code>POST /agents/{"{id}"}/challenge</code><br /><code>backend.activate(id, body)</code> → <code>POST /agents/{"{id}"}/activate</code></p><p>Both add your server-side API key and check that the connection belongs to the signed-in user. Keep the returned session grant private. Never request or transmit an owner private key.</p></div></>}
            {tutorial === "chat" && <><h3>Give your agent a conversation</h3><p>After activation, poll status until the worker reports a heartbeat. Send messages from your backend and render <code>answer.reply</code> in your chat UI. Reuse the same request ID when retrying a message.</p><Code text={chat} /><div className="dev-callout"><strong>Show real status</strong><p><code>starting</code> means the grant is saved; <code>running</code> means the worker has a recent heartbeat. Paper mode uses simulated funds. Live trading needs explicit permission, funding, and no reported blockers.</p></div></>}
          </div>
        </section>
        <section id="reference" className="dev-section"><p className="dev-eyebrow">03 / THE SURFACE AREA</p><h2>Small API. Plenty of possibility.</h2><div className="dev-base"><span>BASE URL</span><code>{BASE}</code></div><div className="dev-endpoints">{endpoints.map(([method, path, description, scope]) => <details key={method + path}><summary><span className={`dev-method ${method.toLowerCase()}`}>{method}</span><code>{path}</code><span className="dev-endpoint-description">{description}</span><b>+</b></summary><p>{description}. Requires <code>{scope}</code> and your backend’s <code>Authorization: Bearer &lt;key&gt;</code> header.</p></details>)}</div><a className="dev-textlink" href="https://github.com/millw14/merrymen/blob/codex/embedded-partner-api/gateway/PARTNER-API.md" target="_blank" rel="noreferrer">Read the full request & response reference ↗</a></section>
        <section id="essentials" className="dev-section"><p className="dev-eyebrow">04 / BEFORE YOU SHIP</p><h2>Built for a clear boundary.</h2><div className="dev-essentials"><article><span>01</span><h3>Keys belong on the server.</h3><p>Never embed your partner key in browser code, mobile bundles, or a public repository. The browser SDK only prepares wallet permissions.</p></article><article><span>02</span><h3>Ownership comes first.</h3><p>Derive user IDs from your own authenticated sessions. Every agent needs its owner’s signature before your app can use its private context.</p></article><article><span>03</span><h3>A reply is not a trade.</h3><p>Chat proposals are not executed automatically. Agent workers follow their signed permissions and configured strategy. No provider available? Chat says so.</p></article><article><span>04</span><h3>Rotate without losing users.</h3><p>Replace a key to keep the same app ID. Update your backend, then revoke the old key. Disconnecting an app does not stop the underlying agent.</p></article></div></section>
      </div>
    </div>
    <section className="dev-bottom"><span>LET THEM BRING THEIR MERRYMAN.</span><h2>Your next feature<br />has a mind of its own.</h2><a className="dev-primary" href="#api-keys">Start building ↗</a></section>
  </main>;
}
