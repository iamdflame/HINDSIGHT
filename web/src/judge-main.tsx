import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Judge } from './judge/Judge';
import { startLenis } from './shared/lenis';
import 'lenis/dist/lenis.css';
import './styles.css';

// /judge's own entry: it renders the claims document and nothing of the instrument, so it must not
// evaluate the question, record and watch modules just to read CLAIMS.md.
startLenis();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Judge />
  </StrictMode>,
);
