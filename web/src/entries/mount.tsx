import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { startLenis } from '../shared/lenis';
import 'lenis/dist/lenis.css';
import '../styles.css';

/** Every route is its own document and its own entry, so a page loads only what it renders. */
export function mount(node: ReactNode) {
  startLenis();
  createRoot(document.getElementById('root')!).render(<StrictMode>{node}</StrictMode>);
}
