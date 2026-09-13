import claims from '../../../CLAIMS.md?raw';
import { Page } from '../shell/Page';
import { ClaimsDocument } from '../judge/ClaimsDocument';

/** CLAIMS.md as a designed page. The law; the court is at /judge. */
export function Claims() {
  return (
    <Page active="claims">
      <ClaimsDocument source={claims} />
    </Page>
  );
}
