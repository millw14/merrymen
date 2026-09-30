import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenActivity } from './TokenActivity';
import { emptyGeckoBuckets } from '../../../worker/src/venues/geckoterminal';
import type { DiscoveryRow } from '@/lib/read-discoveries';
const coin = { venue:'Pons',reserveUsd:4000,volume24hUsd:null,buyers24h:null,onCurve:true,buckets:emptyGeckoBuckets() } as DiscoveryRow;
test('token activity distinguishes unavailable from empty, labels virtual liquidity and links market trades',()=>{
  const unavailable=renderToStaticMarkup(React.createElement(TokenActivity,{coin,evidence:null,loading:false}));
  assert.match(unavailable,/Virtual \/ indexed reserve/);assert.match(unavailable,/temporarily unavailable/);assert.match(unavailable,/—/);assert.doesNotMatch(unavailable,/No matching trades/);
  const evidence={token:'0x'+'1'.repeat(40),poolId:'0x'+'2'.repeat(40),candles:{failed:false,data:[]},trades:{failed:false,observedAt:Date.now(),data:[{id:'a',tx:'0x'+'3'.repeat(64),time:Date.now()/1000,side:'buy' as const,usd:5.25,priceUsd:0.2}]}};
  const populated=renderToStaticMarkup(React.createElement(TokenActivity,{coin,evidence,loading:false}));
  assert.match(populated,/Public market trades, not your agent/);assert.match(populated,/robinhoodchain.blockscout.com\/tx\/0x333/);assert.match(populated,/>Buy</);
  evidence.trades.data=[];
  assert.match(renderToStaticMarkup(React.createElement(TokenActivity,{coin,evidence,loading:false})),/No matching trades were returned/);
});
