export type Claim = {
  id: number;
  status: number;        // 0 None · 1 Open · 2 Refuted · 3 Standing (AbsenceRegistry.Status)
  bond: bigint;
  openUntil: number;
  spanFrom: number;
  spanTo: number;
  venue: string;
  topic0: string;
  subject: string;
  subjectTopic: number;
  claimant: string;
  refuter: string;
};

export type Hunt =
  | { k: 'idle' }
  | { k: 'scanning' }
  | { k: 'none' }
  | { k: 'found'; txHash: string; block: number }
  | { k: 'error'; msg: string };

export const STATUS_KIND = { 0: 'none', 1: 'pending', 2: 'destroyed', 3: 'economic' } as const;
