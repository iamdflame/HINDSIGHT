/** First tab stop on every route: straight past the masthead and nav to the page's content. */
export function SkipLink({ target = 'main' }: { target?: string }) {
  return (
    <a className="skip" href={`#${target}`}>
      Skip to content
    </a>
  );
}
