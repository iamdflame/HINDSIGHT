import doc from '../../../docs/INTEGRATING.md?raw';
import { Page } from '../shell/Page';
import { ClaimsDocument } from '../judge/ClaimsDocument';

/** `docs/INTEGRATING.md`, rendered, so the page and the document cannot disagree. */
export function Integrate() {
  return (
    <Page active="integrate">
      <ClaimsDocument source={doc} />
    </Page>
  );
}
