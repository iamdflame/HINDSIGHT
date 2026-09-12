import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Independence } from './independence/Independence';
import { startLenis } from './shared/lenis';
import 'lenis/dist/lenis.css';
import './styles.css';

// Its own entry, like /judge: the demonstration does not need the instrument's three chapters,
// and loading them would put the whole of ethers in front of the first paint.
startLenis();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Independence />
  </StrictMode>,
);
