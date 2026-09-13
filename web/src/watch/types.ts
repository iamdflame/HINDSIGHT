export type Claim = {
  id: number;
  status: number; // 0 None · 1 Open · 2 Refuted · 3 Standing
  kind: 0 | 1; // 0 EmptySet · 1 CompleteSet
  chainKey: number;
  bond: bigint; // staked; never mutated
  enforceableLoss: bigint; // the share a liar cannot recover
  openUntil: number;
  spanFrom: number;
  spanTo: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  claimant: string;
  refuter: string;
  members: number;
};

export type Member = { height: number; txIndex: number; logIndex: number };

export type Hunt =
  | { k: 'idle' }
  | { k: 'scanning'; note: string }
  | { k: 'none'; corroboratedBy: string[]; scanned: number }
  | { k: 'found'; txHash: string; block: number; txIndex: number; logIndex: number; members?: Member[] }
  | { k: 'error'; msg: string };

export const STATUS_KIND = { 0: 'none', 1: 'pending', 2: 'destroyed', 3: 'economic' } as const;
