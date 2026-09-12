import { Seal } from '../brand/Seal';

export type AssuranceKind = 'cryptographic' | 'economic' | 'pending' | 'destroyed' | 'none';

/**
 * The invariant this whole interface exists to keep: the kinds never render the same way.
 * Colour is never the only channel — the word is always present (§15).
 */
const KIND: Record<AssuranceKind, { word: string; caption?: string }> = {
  cryptographic: { word: 'PROVEN', caption: 'Cryptographic. Merkle path against a notarised root.' },
  economic: { word: 'STANDING', caption: 'Economic — unrefuted. Not a proof of absence.' },
  destroyed: { word: 'REFUTED', caption: 'A counterexample was revealed. The bond moved.' },
  pending: { word: 'OPEN' },
  none: { word: 'NONE' },
};

export function MiniStamp({ kind }: { kind: AssuranceKind }) {
  const tone = kind === 'cryptographic' ? 'ink' : kind === 'economic' ? 'ochre' : kind === 'destroyed' ? 'wax' : 'rule';
  const impression = kind === 'pending' || kind === 'none' ? 'idle' : 'press';
  return <Seal size={18} tone={tone} impression={impression} cancelled={kind === 'destroyed'} title="" />;
}

export function Assurance({ kind, withCaption = true }: { kind: AssuranceKind; withCaption?: boolean }) {
  const k = KIND[kind];
  return (
    <div className={`assurance assurance--${kind}`}>
      <MiniStamp kind={kind} />
      <span className="assurance-word">{k.word}</span>
      {withCaption && k.caption && <p className="assurance-caption t-caption">{k.caption}</p>}
    </div>
  );
}

export function assuranceWord(kind: AssuranceKind): string {
  return KIND[kind].word;
}
