/**
 * Keep a sealed span reaching the archive head, so a lender can be told where history is rather than
 * made to walk it.
 *
 * Usage:
 *   node src/spans.ts                       list the sealed spans and the offer for a 90-day window
 *   node src/spans.ts --roll [--chain 3]    extend the top span up to the head, sealing one if needed
 *   node src/spans.ts --consolidate        build one span that covers a whole 90-day window by itself
 *   node src/spans.ts --check               exit 1 if the offer for 90 days does not reach the head
 *
 * `--key ENV_VAR` names the wallet that signs. Give any worker that writes on its own schedule a wallet
 * of its own: two processes sharing one signer race for the same nonce and one of them loses the
 * transaction to `replacement transaction underpriced`.
 *
 * WHY
 * ---
 * `UnderwritingDesk` used to prove depth by walking the held bitmap across the policy's whole window:
 * 2,532 cold SLOADs, 7.03M gas for ninety days, inside `borrow`. The walk is the same every time, so it
 * is done once by `sealSpan` and the answer is recorded; a caller then hands the desk the span ids it
 * relies on and the desk checks they are adjacent, on the right chain, long enough and recent enough.
 *
 * Sealing and extending are both permissionless and neither grants anything -- a span is a receipt for
 * a walk anyone could repeat, and a caller who offers a stale or short set is refused exactly as before.
 * So this worker is a convenience for the desk's users, not a privileged operator.
 *
 * `extendSpan` walks only the newly added heights (at most `MAX_SEAL_WINDOW` per call), which is why the
 * top span can follow the head forever at a few hundred thousand gas a day rather than being re-sealed.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { CC_RPC, MIRROR, MIRROR_ABI, CHAINS, EXPLORER, privateKey } from './config.ts';

export const NINETY_DAYS = 648_000;

export type Span = { id: number; chainKey: number; from: number; to: number };

const get = (f: string) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Every sealed span on one chain, newest last. `spanCount` is small and this is the source of truth. */
export async function allSpans(mirror: Contract, chainKey: number): Promise<Span[]> {
  const n = Number(await mirror.spanCount());
  const out: Span[] = [];
  for (let i = 0; i < n; i++) {
    const s = await mirror.spanOf(i);
    if (Number(s.chainKey) !== chainKey) continue;
    out.push({ id: i, chainKey, from: Number(s.fromBlock), to: Number(s.toBlock) });
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * The span that reaches highest, and among those the one that reaches furthest back. This is the span
 * a window is measured down from and the one the roller drags along behind the head.
 */
export function topSpan(spans: Span[]): Span | null {
  let best: Span | null = null;
  for (const s of spans) if (!best || s.to > best.to || (s.to === best.to && s.from < best.from)) best = s;
  return best;
}

/**
 * The span ids to hand the desk for a window of `window` blocks: the shortest adjacent run ending at
 * the highest sealed height. Returns null if no adjacent run is long enough, which is exactly the
 * case in which the desk would refuse `ArchiveTooShallow` -- so a caller can say so before spending gas.
 *
 * Fewer is cheaper: each `spanOf` the desk reads is a cross-contract call and two cold slots, so a
 * single consolidated span answers a ninety-day question for about half the gas that five do.
 */
export function offerFor(spans: Span[], window: number, maxSpans = 8): { ids: number[]; from: number; to: number } | null {
  const top = topSpan(spans);
  if (!top) return null;
  const ids = [top.id];
  let from = top.from;
  // Walk down while some span below ends exactly where this one starts. Order matters to the desk: it
  // checks `sp.fromBlock == previous.toBlock + 1`, so the ids go low to high.
  while (top.to - from < window && ids.length < maxSpans) {
    const below = spans.find((s) => s.to + 1 === from && s.id !== top.id);
    if (!below) break;
    from = below.from;
    ids.unshift(below.id);
  }
  if (top.to - from < window) return null;
  return { ids, from, to: top.to };
}

/**
 * The highest height `[from, ...]` runs to without a gap, capped at `limit`.
 *
 * `contiguousFrom` does the walk inside the contract, so this is one `eth_call` rather than one per
 * 256 heights -- which matters: a ninety-day range is 2,532 words, and asking for them one at a time
 * took minutes of round trips to answer a question the chain answers in a single view.
 */
async function contiguousTo(mirror: Contract, chainKey: number, from: number, limit: number): Promise<number> {
  if (limit < from) return from - 1;
  const run = Number(await mirror.contiguousFrom(chainKey, from, limit - from + 1));
  return from + run - 1;
}

/**
 * Build one span covering at least `window` heights and ending at the head, so the desk reads a single
 * seal instead of a chain of them. Seals the first `MAX_SEAL_WINDOW` and then extends upward in chunks;
 * the walk is the same one a caller would otherwise pay for on every single question.
 */
export async function consolidate(mirror: Contract, chainKey: number, window: number, log = console.log): Promise<number | null> {
  const maxWindow = Number(await mirror.MAX_SEAL_WINDOW());
  const head = Number(await mirror.highestMirrored(chainKey));
  const lowest = Number(await mirror.lowestMirrored(chainKey));
  // Idempotent on *any* span wide enough, not merely the highest-reaching one: a fresh 131,072-height
  // seal at the head outranks a 680,401-height span sitting a few thousand below it, and consolidating
  // again because of that would buy a second copy of a span that already exists.
  const spans = await allSpans(mirror, chainKey);
  const wide = spans.filter((x) => x.to - x.from >= window).sort((a, b) => b.to - a.to)[0];
  if (wide) {
    log(`  = span ${wide.id} already covers ${(wide.to - wide.from + 1).toLocaleString()} heights on its own`);
    if (wide.to < head) {
      const next = Math.min(head, wide.to + maxWindow);
      const to = await contiguousTo(mirror, chainKey, wide.to + 1, next);
      if (to > wide.to) {
        const rc = await (await mirror.extendSpan(wide.id, to)).wait();
        log(`  + span ${wide.id} → ${to.toLocaleString()}  (+${(to - wide.to).toLocaleString()} heights, ${Number(rc.gasUsed).toLocaleString()} gas)`);
      }
    }
    return wide.id;
  }

  // Start low enough that the finished span covers the window with room for the head to move, but no
  // lower than the archive actually runs, and only where history is unbroken.
  let start = Math.max(lowest, head - Math.floor(window * 1.05));
  const reach = await contiguousTo(mirror, chainKey, start, head);
  if (reach < start + window) {
    // A hole sits inside the intended range: begin above it instead of pretending it is not there.
    const above = await firstContiguousStartBelow(mirror, chainKey, head, window);
    if (above === null) {
      log(`  ! no unbroken run of ${window.toLocaleString()} heights below ${head.toLocaleString()} to consolidate`);
      return null;
    }
    start = above;
  }

  const first = Math.min(head, start + maxWindow - 1);
  let tx = await mirror.sealSpan(chainKey, start, first);
  let rc = await tx.wait();
  const id = Number(rc.logs.map((l: any) => { try { return mirror.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === 'SpanSealed')!.args.spanId);
  log(`  + sealed span ${id} ${start.toLocaleString()}..${first.toLocaleString()}  ${Number(rc.gasUsed).toLocaleString()} gas`);

  let to = first;
  while (to < head) {
    const next = Math.min(head, to + maxWindow);
    tx = await mirror.extendSpan(id, next);
    rc = await tx.wait();
    log(`  + span ${id} → ${next.toLocaleString()}  (+${(next - to).toLocaleString()} heights, ${Number(rc.gasUsed).toLocaleString()} gas)`);
    to = next;
  }
  log(`  span ${id} covers ${start.toLocaleString()}..${to.toLocaleString()} = ${(to - start + 1).toLocaleString()} heights, alone`);
  return id;
}

/**
 * The lowest height from which history runs unbroken all the way up to `head`, or null if that run is
 * shorter than `window`. Binary search over `contiguousFrom`: about twenty calls instead of thousands,
 * and it asks the chain the same question a caller's desk would.
 */
async function firstContiguousStartBelow(mirror: Contract, chainKey: number, head: number, window: number): Promise<number | null> {
  const lowest = Number(await mirror.lowestMirrored(chainKey));
  const reaches = async (x: number) => (await contiguousTo(mirror, chainKey, x, head)) === head;
  if (!(await reaches(head))) return null;
  let lo = lowest; // may not reach
  let hi = head; // does reach
  if (await reaches(lo)) hi = lo;
  else {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await reaches(mid)) hi = mid;
      else lo = mid;
    }
  }
  return head - hi >= window ? hi : null;
}

/** Extend the top span up to the head, or seal a first one. Returns how many heights were added. */
export async function roll(mirror: Contract, chainKey: number, log = console.log): Promise<number> {
  const maxWindow = Number(await mirror.MAX_SEAL_WINDOW());
  const head = Number(await mirror.highestMirrored(chainKey));
  if (head === 0) return 0;
  const spans = await allSpans(mirror, chainKey);

  if (spans.length === 0) {
    const lowest = Number(await mirror.lowestMirrored(chainKey));
    const start = Math.max(lowest, head - maxWindow + 1);
    const to = await contiguousTo(mirror, chainKey, start, head);
    if (to < start) {
      log(`  ! ${CHAINS[chainKey].name}: nothing contiguous above ${start.toLocaleString()} to seal`);
      return 0;
    }
    const tx = await mirror.sealSpan(chainKey, start, to);
    await tx.wait();
    log(`  + sealed ${start.toLocaleString()}..${to.toLocaleString()} (${(to - start + 1).toLocaleString()} heights)  ${EXPLORER}/tx/${tx.hash}`);
    return to - start + 1;
  }

  const top = topSpan(spans)!;
  if (top.to >= head) return 0;
  // One call may only walk `MAX_SEAL_WINDOW` new heights, and only over a gap-free run.
  const ceiling = Math.min(head, top.to + maxWindow);
  const to = await contiguousTo(mirror, chainKey, top.to + 1, ceiling);
  if (to <= top.to) {
    log(`  = ${CHAINS[chainKey].name}: span ${top.id} ends at ${top.to.toLocaleString()}, and ${(top.to + 1).toLocaleString()} is not held — nothing to extend over`);
    return 0;
  }
  const tx = await mirror.extendSpan(top.id, to);
  const rc = await tx.wait();
  log(
    `  + span ${top.id} ${top.to.toLocaleString()} → ${to.toLocaleString()} ` +
      `(+${(to - top.to).toLocaleString()} heights, ${Number(rc.gasUsed).toLocaleString()} gas)  ${EXPLORER}/tx/${tx.hash}`,
  );
  return to - top.to;
}

async function main() {
  const chains = get('--chain') ? [Number(get('--chain'))] : [3, 1];
  const window = Number(get('--window') ?? NINETY_DAYS);
  const cc = new JsonRpcProvider(CC_RPC);
  const rolling = process.argv.includes('--roll');
  const consolidating = process.argv.includes('--consolidate');
  const keyEnv = get('--key');
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (keyEnv && !key) throw new Error(`--key ${keyEnv} is set but that variable is empty`);
  const mirror = new Contract(MIRROR, MIRROR_ABI, rolling || consolidating ? new Wallet(key ?? privateKey(), cc) : cc);

  let bad = 0;
  for (const chainKey of chains) {
    const name = CHAINS[chainKey]?.name ?? `chainKey ${chainKey}`;
    console.log(`\n${name} (chainKey ${chainKey})`);
    if (consolidating) await consolidate(mirror, chainKey, window);
    if (rolling) await roll(mirror, chainKey);

    const spans = await allSpans(mirror, chainKey);
    const head = Number(await mirror.highestMirrored(chainKey));
    for (const s of spans) {
      console.log(`  span ${String(s.id).padStart(3)}  ${s.from.toLocaleString()} .. ${s.to.toLocaleString()}  ${(s.to - s.from + 1).toLocaleString()} heights`);
    }
    const offer = offerFor(spans, window);
    if (!offer) {
      console.log(`  offer for ${window.toLocaleString()} blocks: none — no adjacent run is that long`);
      bad++;
      continue;
    }
    const lag = head - offer.to;
    console.log(
      `  offer for ${window.toLocaleString()} blocks: spans [${offer.ids.join(', ')}]  ` +
        `${offer.from.toLocaleString()}..${offer.to.toLocaleString()}  ${lag === 0 ? 'at the head' : `${lag.toLocaleString()} below the head`}`,
    );
    // A BlankFile policy carries `maxStaleness 0`, so anything below the head refuses outright.
    if (lag !== 0) bad++;
  }

  if (process.argv.includes('--check')) {
    if (bad) {
      console.log(`\n${bad} chain(s) cannot currently prove a ${window.toLocaleString()}-block window at the head.`);
      process.exit(1);
    }
    console.log('\nevery chain can prove the window at the head.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
