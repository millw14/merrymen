// Share the website's publication presentation rules; SwiftUI draws the rows.
import { beatsOf, pillBeats, mentionTargets, verbOf, pillOf, watchCount, type Beat, type FeedRow, type Mention, type Pill } from '../../web/src/terminal/beat';

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
