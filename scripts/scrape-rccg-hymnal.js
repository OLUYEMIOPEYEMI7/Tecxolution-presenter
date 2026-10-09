#!/usr/bin/env node
// Scrapes all 826 hymns from the RCCG "Redeemed Hymnal - 4th Edition" at
// getrhema.net into data/rccg-hymnal.json, in the same song/section/pairs
// schema the presenter app already uses.
const https = require('https');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const TOTAL = 826;
const BASE = 'https://getrhema.net/hymns/rccg-the-redeemed-hymnal-4/';
const CONCURRENCY = 12;
const BACKGROUND_POOL = [
  '/images/01_broken_world.jpg', '/images/02_new_creation.jpg', '/images/03_lion_lamb_scroll.jpg',
  '/images/04_christ_glory.jpg', '/images/05_dove_presence.jpg', '/images/06_every_nation.jpg',
  '/images/07_final_throne.jpg',
];

function fetchHtml(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', (e) => {
        if (n > 0) setTimeout(() => attempt(n - 1), 500);
        else reject(e);
      }).on('timeout', function () { this.destroy(new Error('timeout')); });
    };
    attempt(retries);
  });
}

function parseHymn(html, num) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim();
  if (!title) return null;

  const sections = [];
  $('#hymn-verses .verse').each((i, el) => {
    // Each .verse block can contain multiple h2/p pairs in sequence
    // (e.g. VERSE 1 + its CHORUS as siblings) — walk all of them in order.
    const children = $(el).children('h2, p').toArray();
    for (let j = 0; j < children.length; j += 2) {
      const h2 = children[j];
      const p = children[j + 1];
      if (!h2 || !p || h2.tagName !== 'h2' || p.tagName !== 'p') continue;
      const label = $(h2).text().trim().toUpperCase() || `VERSE ${i + 1}`;
      const htmlInner = $(p).html() || '';
      const lines = htmlInner
        .split(/<br\s*\/?>/i)
        .map((l) => $('<div>').html(l).text().trim())
        .map((l) => l.replace(/^\.\s+/, '')) // strip stray CSS-counter artifact leaking as ". "
        .filter((l) => l.length > 0);
      if (lines.length === 0) continue;
      sections.push({
        label,
        pairs: lines.map((l) => [l, '']),
        background: BACKGROUND_POOL[num % BACKGROUND_POOL.length],
      });
    }
  });

  if (sections.length === 0) return null;

  return {
    id: `rccg-hymn-${num}`,
    title,
    artist: `RCCG Hymnal #${num}`,
    hymnNumber: num,
    sections,
  };
}

async function main() {
  const results = new Array(TOTAL + 1).fill(null);
  let completed = 0;
  let failed = [];

  async function worker(nums) {
    for (const n of nums) {
      try {
        const html = await fetchHtml(BASE + n);
        const hymn = parseHymn(html, n);
        if (hymn) results[n] = hymn;
        else failed.push(n);
      } catch (e) {
        failed.push(n);
      }
      completed++;
      if (completed % 50 === 0) console.log(`Progress: ${completed}/${TOTAL}`);
    }
  }

  const allNums = Array.from({ length: TOTAL }, (_, i) => i + 1);
  const buckets = Array.from({ length: CONCURRENCY }, () => []);
  allNums.forEach((n, i) => buckets[i % CONCURRENCY].push(n));

  await Promise.all(buckets.map(worker));

  const hymns = results.filter(Boolean);
  console.log(`Scraped ${hymns.length}/${TOTAL} hymns. Failed: ${failed.length}`);
  if (failed.length > 0) console.log('Failed numbers:', failed.slice(0, 30));

  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'rccg-hymnal.json'),
    JSON.stringify({ hymns }, null, 2)
  );
  console.log('Saved data/rccg-hymnal.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
