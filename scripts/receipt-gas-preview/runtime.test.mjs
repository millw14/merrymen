import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { it } from 'node:test';
import { createReadOnlyChain, RPC_METHODS } from './runtime.ts';

it('actual RPC transport sends only read requests and refuses a mismatched response ID', async () => {
  const seen = [];
  let mismatch = false;
  const server = createServer(async (request,response) => {
    let body = '';
    for await (const part of request) body += part;
    const rpc = JSON.parse(body);
    seen.push(rpc.method);
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({jsonrpc:'2.0',id:mismatch?rpc.id+1:rpc.id,
      result:rpc.method==='eth_chainId'?'0x1237':'0xc8'}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const chain=createReadOnlyChain(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(Object.keys(chain).sort(),['block','chainId','head','latestRound','receipt','round']);
    assert.equal(await chain.chainId(),4663);
    assert.equal(await chain.head(),200n);
    mismatch=true;
    await assert.rejects(chain.chainId(),/Receipt RPC read failed/);
    assert.deepEqual(seen,['eth_chainId','eth_blockNumber','eth_chainId']);
    assert.ok(seen.every(method=>RPC_METHODS.includes(method)));
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
