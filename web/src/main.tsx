import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startLenis } from './shared/lenis';
import 'lenis/dist/lenis.css';
import './styles.css';

const Judge = lazy(() => import('./judge/Judge').then((m) => ({ default: m.Judge })));
const path = window.location.pathname.replace(/\/+$/, '');

startLenis();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {path === '/judge' ? <Suspense fallback={null}><Judge /></Suspense> : <App />}
  </StrictMode>,
);
