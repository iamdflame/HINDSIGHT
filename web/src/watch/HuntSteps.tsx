import type { StepState } from '../shared/Steps';

/** §12.1 — the hunt as three numbered serif steps. Commit–reveal's reason sits under step two. */
export function HuntSteps({ states, wallet, action }: {
  states: [StepState, StepState, StepState];
  wallet: React.ReactNode;
  action?: React.ReactNode;
}) {
  const cls = (s: StepState) => (s === 'todo' ? undefined : s);
  return (
    <ol className="hunt-steps">
      <li className={cls(states[0])}>
        <span className="step-text">Connect a Creditcoin wallet.</span>
        {wallet}
      </li>
      <li className={cls(states[1])}>
        <span className="step-text">Commit the evidence (hash only).</span>
        <span className="t-caption">
          A one-shot call would put the evidence in public calldata where any searcher could copy it and take the bounty first.
        </span>
      </li>
      <li className={cls(states[2])}>
        <span className="step-text">Wait one block, then reveal and take the bond.</span>
        {action}
      </li>
    </ol>
  );
}
