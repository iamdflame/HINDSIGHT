import brief from '../../../docs/ENSHRINE.md?raw';
import { Page } from '../shell/Page';
import { ClaimsDocument } from '../judge/ClaimsDocument';
import { IndependenceModule, useIndependence } from '../independence/IndependenceModule';

/**
 * The enshrinement RFC, rendered from `docs/ENSHRINE.md` so the page and the document can never
 * disagree, with the experiment it cites running live between the argument and the proposal.
 */
export function Enshrine() {
  const indep = useIndependence(true);
  const marker = '\n## 5.';
  const at = brief.indexOf(marker);
  const before = at >= 0 ? brief.slice(0, at) : brief;
  const after = at >= 0 ? brief.slice(at) : '';
  return (
    <Page active="enshrine">
      <div className="enshrine">
        <ClaimsDocument source={before} />
        <section className="enshrine-live" aria-label="The experiment, live">
          <p className="beat-n t-hash">the experiment section 4 describes, running now</p>
          <IndependenceModule state={indep} compact />
        </section>
        {after && <ClaimsDocument source={after} />}
      </div>
    </Page>
  );
}
