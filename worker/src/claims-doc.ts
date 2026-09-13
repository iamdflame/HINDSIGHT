/**
 * Render the documents that carry numbers from the measured record, so no number is typed.
 *
 * Usage:
 *   node src/claims-doc.ts            write CLAIMS.md and README.md from docs/templates/
 *   node src/claims-doc.ts --check    exit 1 if either differs from what the record renders (CI)
 *
 * A template holds prose and placeholders: `{{measured.chains.3.held|n}}`. The value comes from
 * deployments.json -- which `measure.ts --write` fills from the chain, and whose `--check` fails when
 * the chain stops agreeing with it -- so the path from chain to sentence has no hand in it.
 *
 * Formats: `n` thousands separators · `tctc` wei to tCTC · `short` 0x1234…abcd · `days` one decimal ·
 * `gwei` · none: the value as it is. An unresolved placeholder is an error, never an empty string.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const PAIRS: [string, string][] = [
  ['docs/templates/CLAIMS.md', 'CLAIMS.md'],
  ['docs/templates/README.md', 'README.md'],
  ['docs/templates/MIGRATION.md', 'docs/MIGRATION.md'],
  ['docs/templates/ENSHRINE.md', 'docs/ENSHRINE.md'],
];

function lookup(obj: any, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^-?\d+$/.test(part) ? cur.at(Number(part)) : cur[part];
  }
  return cur;
}

function format(v: unknown, fmt: string | undefined, where: string): string {
  if (v === undefined || v === null) throw new Error(`${where}: no value`);
  switch (fmt) {
    case undefined:
      return String(v);
    case 'n':
      return Number(v).toLocaleString('en-US');
    case 'tctc': {
      const wei = BigInt(v as string);
      const whole = wei / 10n ** 18n;
      const frac = ((wei % 10n ** 18n) * 100n) / 10n ** 18n;
      return `${whole.toLocaleString('en-US')}.${frac.toString().padStart(2, '0')}`;
    }
    case 'short': {
      const s = String(v);
      return `${s.slice(0, 6)}…${s.slice(-4)}`;
    }
    case 'days':
      return Number(v).toFixed(1);
    case 'gwei':
      return (Number(v) / 1e9).toFixed(2);
    default:
      throw new Error(`${where}: unknown format "${fmt}"`);
  }
}

/**
 * `{{#each path}}…{{/each}}` repeats its body per element, with `{{.field}}` reading the element;
 * `{{#each path where field=a,b}}` keeps elements whose field is one of the listed values. An empty
 * list renders nothing -- callers say so in prose rather than relying on a blank table.
 */
export function render(template: string, record: any, name: string): string {
  const each = template.replace(/\{\{#each ([\w.\-]+)(?: where (\w+)=([\w,\-]+))?\}\}\n?([\s\S]*?)\{\{\/each\}\}\n?/g, (_, path: string, field: string | undefined, values: string | undefined, body: string) => {
    const list = lookup(record, path);
    if (!Array.isArray(list)) throw new Error(`${name}: {{#each ${path}}} is not a list`);
    const keep = values ? new Set(values.split(',')) : null;
    return list
      .filter((item) => !keep || keep.has(String(item[field!])))
      .map((item) =>
        body.replace(/\{\{\s*\.([\w.\-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_m: string, f: string, fmt: string | undefined) => format(lookup(item, f), fmt, `${name}: {{.${f}}} in ${path}`)),
      )
      .join('');
  });
  return each.replace(/\{\{\s*([\w.\-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_, path: string, fmt: string | undefined) =>
    format(lookup(record, path), fmt, `${name}: {{${path}${fmt ? '|' + fmt : ''}}}`),
  );
}

/** Facts read from the repository itself at render time: they cannot drift from the code they count. */
function staticFacts() {
  const dir = new URL('contracts/test/', ROOT);
  let tests = 0;
  let fuzz = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.t.sol')) continue;
    const src = readFileSync(new URL(f, dir), 'utf8');
    tests += (src.match(/function test\w*\s*\(/g) ?? []).length;
    fuzz += (src.match(/function testFuzz\w*\s*\(/g) ?? []).length;
  }
  return { forgeTests: tests, fuzzTests: fuzz };
}

function main() {
  const check = process.argv.includes('--check');
  const record = { ...JSON.parse(readFileSync(new URL('deployments.json', ROOT), 'utf8')), static: staticFacts() };
  let stale = 0;
  for (const [tpl, out] of PAIRS) {
    const tplUrl = new URL(tpl, ROOT);
    if (!existsSync(tplUrl)) throw new Error(`missing template ${tpl}`);
    const rendered = render(readFileSync(tplUrl, 'utf8'), record, tpl);
    const outUrl = new URL(out, ROOT);
    const current = existsSync(outUrl) ? readFileSync(outUrl, 'utf8') : '';
    if (check) {
      if (current !== rendered) {
        stale++;
        const a = current.split('\n');
        const b = rendered.split('\n');
        const i = a.findIndex((line, k) => line !== b[k]);
        console.log(`STALE ${out}: first difference at line ${i + 1}\n  file:     ${a[i]?.slice(0, 160)}\n  rendered: ${b[i]?.slice(0, 160)}`);
      } else console.log(`ok    ${out} matches ${tpl} rendered from deployments.json`);
    } else {
      writeFileSync(outUrl, rendered);
      console.log(`wrote ${out}`);
    }
  }
  // The handful of measured facts the site prints without a chain client, extracted so the page shell
  // does not ship the whole record. Same --check discipline as the documents.
  {
    const facts = {
      continuityByAge: (record.measured?.continuityByAge?.rows ?? []).map((r: any) => ({ label: r.label, age: r.age, block: r.block, roots: r.roots })),
      widestCallRoots: record.measured?.chains?.['3']?.widestCall?.roots ?? null,
    };
    const body = JSON.stringify(facts, null, 1) + '\n';
    const url = new URL('web/src/lib/record.generated.json', ROOT);
    const current = existsSync(url) ? readFileSync(url, 'utf8') : '';
    if (check) {
      if (current !== body) {
        stale++;
        console.log('STALE web/src/lib/record.generated.json');
      } else console.log('ok    web/src/lib/record.generated.json matches deployments.json');
    } else {
      writeFileSync(url, body);
      console.log('wrote web/src/lib/record.generated.json');
    }
  }

  if (stale) {
    console.log('\nA number was edited by hand, or the record changed without regenerating. Run: node worker/src/claims-doc.ts');
    process.exit(1);
  }
}

// Run only as a script, so `render` can be imported and tested.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
