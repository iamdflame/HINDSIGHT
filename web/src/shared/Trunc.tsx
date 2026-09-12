/** Middle-truncates a hex value, keeping the full value one hover away. */
export function Trunc({ v, head = 6, tail = 4 }: { v: string; head?: number; tail?: number }) {
  if (!v) return <>—</>;
  const short = v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
  return <span className="t-hash" title={v}>{short}</span>;
}
