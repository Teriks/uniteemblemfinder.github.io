// Probe/scrape the unite-db boost-emblems page into unitedb_page.html
// (ported from the former Python probe). The page URL is configurable via
// UNITEDB_BASE / UNITEDB_PAGE_URL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageUrl, httpText } from './lib/unitedb.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'unitedb_page.html');

export async function fetchUnitedb({ log = console.log } = {}) {
  const html = await httpText(pageUrl(), 'Mozilla/5.0');
  fs.writeFileSync(OUT, html, 'utf8');
  log(`html length: ${html.length}`);

  for (const pat of ['Bulbasaur', 'boostEmblems', 'boost_emblems', 'emblemData', 'self.__next_f']) {
    log(`${pat} ${html.indexOf(pat)}`);
  }

  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/g)].map((m) => m[1]);
  log(`next_f chunks: ${chunks.length}`);
  for (const c of chunks.slice(0, 3)) log(` chunk preview ${c.slice(0, 150)}`);

  const arr = html.match(/\[{"name":[^\]]{50,}/);
  if (arr) log(`array at ${arr.index} ${arr[0].slice(0, 200)}`);

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  log(`external scripts: ${JSON.stringify(scripts.slice(0, 10))}`);
  return html;
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  fetchUnitedb().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
