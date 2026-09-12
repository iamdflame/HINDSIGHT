/** §9.3 — first tab stop. Always lands on the question, switching chapter if needed. */
export function SkipLink({ onSkip }: { onSkip: () => void }) {
  return (
    <a className="skip" href="#question" onClick={(e) => { e.preventDefault(); onSkip(); }}>
      Skip to the question
    </a>
  );
}
