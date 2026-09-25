// Share the website's publication presentation rules; SwiftUI draws the rows.
import { beatsOf, pillBeats, mentionTargets, verbOf, pillOf, watchCount, type Beat, type FeedRow, type Mention, type Pill } from '../../web/src/terminal/beat';
import { chartWindows, defaultWindow, growthWindow, thesisOfHow, type ChartWindow } from '../../web/src/terminal/profile-view';
import { STOCK_TOKENS } from '../../packages/core/src/tokens';
import { commandFor, commandPayload, isComplete, type CommandArg } from '../../web/src/lib/chat-commands';
import { seedSources, withRead, liveOf, mineOf } from '../../web/src/terminal/live';
import { positionsOf, spentToday } from '../../web/src/terminal/account';
import { telegramRow, trencherRow } from '../../web/src/terminal/agent-status';

export function overview(json: string): string {
  const { feed, now } = JSON.parse(json);
  if (!feed || feed.source === 'none') return 'null';
  const mine = mineOf(feed, []);
  // The shared tape calls a completed paper fill "landed" too. Its paper
  // flag must be checked separately before comparing usage with a real cap.
  return JSON.stringify(mine ? { ...mine, positions: positionsOf(mine), spent: spentToday({ ...mine, moves: mine.moves.filter(move => !move.paper) }, now) } : null);
}

export function connections(json: string): string {
  const { telegram, settings } = JSON.parse(json);
  return JSON.stringify({ telegram: telegramRow(telegram), trencher: trencherRow(settings?.values) });
}

export function markets(json: string): string {
  const input = JSON.parse(json);
  let sources = seedSources();
  for (const key of ['market', 'discoveries', 'theses'] as const) {
    if (input[key] && input[key].source !== 'none') sources = withRead(sources, key, { text: JSON.stringify(input[key]), answered: true }, false);
  }
  const tokens = liveOf(sources).tokens;
  if (sources.theses.read !== 'ok') {
    for (const token of tokens) {
      token.agents = null;
      // Discovery can independently know market-wide buyers or launch trades.
      const discovery = sources.discoveries.body?.rows?.find(r => r.token.toLowerCase() === token.id);
      const fresh = sources.discoveries.body?.fresh?.find(r => r.token?.toLowerCase() === token.id);
      token.buys = fresh?.trades ?? discovery?.buyers24h ?? null;
    }
  }
  const count = (value: number | null) => value ?? 0;
  const coinsFirst = (a: { kind: string }, b: { kind: string }) => Number(b.kind === 'memecoin') - Number(a.kind === 'memecoin');
  const ranked = input.sort === 'buys'
    ? tokens.filter(t => count(t.buys) > 0 || t.cast.length > 0).sort((a, b) => coinsFirst(a, b) || count(b.buys) - count(a.buys))
    : tokens.filter(t => count(t.agents) > 0 || t.cast.length > 0).sort((a, b) => coinsFirst(a, b) || count(b.agents) - count(a.agents) || count(b.holders) - count(a.holders));
  const all = [...tokens].sort((a, b) => coinsFirst(a, b) || count(b.change24hPct) - count(a.change24hPct));
  return JSON.stringify({ rows: input.sort === 'all' ? all : ranked.length ? ranked : all.slice(0, 8), fallback: input.sort !== 'all' && !ranked.length });
}

// The model names a registered command, never an API route or arbitrary fields.
// Swift shows this canonical description and opens an editable native review.
export function command(json: string): string {
  const input = JSON.parse(json);
  const cmd = commandFor(input?.id);
  if (!cmd) return 'null';
  const args: Record<string, CommandArg> = {};
  if (input.args && typeof input.args === 'object' && !Array.isArray(input.args)) {
    for (const [key, value] of Object.entries(input.args)) {
      if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) args[key] = value;
    }
  }
  if (!isComplete(cmd, args)) return 'null';
  const payload = commandPayload(cmd, args);
  return JSON.stringify({ id: cmd.id, via: cmd.via, say: cmd.say(args), payload });
}

export function assets(json: string): string {
  const { mode, customTokens } = JSON.parse(json);
  const stocks = STOCK_TOKENS.filter(t => mode === 'all' || (mode === 'crypto' ? t.kind === 'memecoin' : t.kind !== 'memecoin')).map(t => t.symbol);
  const custom = mode === 'stocks' ? [] : (Array.isArray(customTokens) ? customTokens : []).filter((t: { address: string }) => typeof t.address === 'string' && !STOCK_TOKENS.some(s => s.address.toLowerCase() === t.address.toLowerCase())).map((t: { symbol: string }) => t.symbol);
  return JSON.stringify([...new Set([...stocks, ...custom])].sort());
}

export function profile(json: string): string {
  const { agent, picked, nowSec } = JSON.parse(json);
  const points = agent.growth ?? [];
  const windows = chartWindows(points, agent.growthComplete, nowSec);
  const active: ChartWindow = windows.some(w => w.id === picked && w.available) ? picked : defaultWindow(points, agent.growthComplete, nowSec);
  const slice = growthWindow(points, active, nowSec, agent.growthComplete);
  return JSON.stringify({ approach: thesisOfHow(agent.how), windows, active, slice,
    words: windows.find(w => w.id === active)?.words,
    points: slice.state === 'ok' ? points.filter((p: { at: number }) => p.at >= slice.from) : [] });
}

export function render(json: string): string {
  const input = JSON.parse(json) as { rows: FeedRow[]; pill: Pill | 'following'; counts: Record<string, number>; realOnly: boolean; following: string[]; mostLiked: boolean };
  const beats = beatsOf(input.rows, []);
  const targets = mentionTargets(beats);
  const replies = new Map<string, Mention[]>();
  for (const b of beats) {
    const text = `${b.kind === 'view' ? b.head : ''} ${b.reason} ${b.post ?? ''}`.toLowerCase();
    const named = [...targets.values()].filter(who => who.slug !== b.actor.slug && text.includes(`@${who.handle}`));
    const unique = [...new Map(named.map(who => [who.slug, who])).values()];
    if (unique.length) replies.set(b.id, unique);
  }
  const pool = input.pill === 'following' ? beats.filter(b => input.following.includes(b.actor.slug)) : beats;
  const rows = pillBeats(pool, input.pill === 'following' ? 'all' : input.pill, replies, input.counts, { realOnly: input.realOnly });
  if (input.mostLiked) rows.sort((a, b) => (input.counts[b.postId ?? ''] ?? 0) - (input.counts[a.postId ?? ''] ?? 0) || b.rankMs - a.rankMs);
  function row(b: Beat): unknown {
    return {
      ...b,
      title: b.kind === 'trade' ? `${b.actor.name} ${verbOf(b)} ${b.label ?? b.symbol}` : b.kind === 'watch' ? `Still watching ${watchCount(b)} tokens` : b.kind === 'chorus' ? `${b.label ?? b.symbol} · ${b.actors.length} agents holding` : b.head,
      badge: b.kind === 'trade' ? pillOf(b).label : b.kind === 'view' && b.hold ? 'Hold' : null,
      count: b.postId ? input.counts[b.postId] ?? null : null,
      mentions: replies.get(b.id) ?? [],
      members: b.kind === 'chorus' || b.kind === 'watch' ? b.members.map(row) : [],
    };
  }
  return JSON.stringify(rows.map(row));
}
