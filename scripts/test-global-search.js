#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'trade-order-system.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const bodyStart = html.indexOf('{', start);
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] !== '}') continue;
    const candidate = html.slice(start, index + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {
      // Continue until the complete production function compiles.
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}

const context = vm.createContext({ console });
[
  'normalizeSearchText',
  'searchCountryAliasGroups',
  'searchTextDocument',
  'boundedDamerauLevenshtein',
  'searchWordFuzzyMatch',
  'searchTextMatchDetail',
  'searchTextMatches',
  'globalSearchTokens',
  'globalSearchScore',
  'limitGlobalSearchResultsByGroup',
  'globalSearchGroupCounts'
].forEach(name => vm.runInContext(extractFunction(name), context));

function evaluate(expression) {
  return JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
}

const compatibilityCases = [
  ['numbers cannot bypass name', 'Morgan Sample USD 1022', 'Evan 1022', false],
  ['numbers cannot bypass currency', 'Morgan USD 1022', 'EUR 1022', false],
  ['digits cannot cross unrelated fields', '订单 123 金额 456', '2345', false],
  ['combined name and amount', 'Morgan Sample USD 1022', 'Morgan 1022', true],
  ['phone digits ignore formatting', '+44 7700 900127', '447700900127', true],
  ['incomplete phone digits still match', '+44 7700 900127', '7700900', true],
  ['amount ignores currency and grouping', '订单金额 USD 1022', '$1,022', true],
  ['accented text matches plain text', 'Móstoles Madrid', 'Mostoles', true],
  ['UK alias matches country name', '英国 United Kingdom', 'UK', true],
  ['USA alias matches country name', '美国 United States', 'USA', true],
  ['Spain ISO alias matches country name', '西班牙 Spain', 'ES', true],
  ['Switzerland ISO alias matches country name', '瑞士 Switzerland', 'CH', true],
  ['New Zealand ISO alias matches country name', '新西兰 New Zealand', 'NZ', true],
  ['Czechia ISO alias matches country name', '捷克 Czechia', 'CZ', true],
  ['South Africa ISO alias matches country name', '南非 South Africa', 'ZA', true],
  ['country name typo is tolerated', '英国 United Kingdom', 'Untied Kingdom', true],
  ['transposed letters are tolerated', 'Evan Sampleton', 'Evan Sampletno', true],
  ['one missing letter is tolerated', 'Ashley Parker', 'Ashley Parkr', true],
  ['short country aliases do not match substrings', 'business account', 'US', false],
  ['unrelated names do not fuzzy match', 'Ashley Parker', 'Morgan Sample', false]
];

for (const [name, haystack, query, expected] of compatibilityCases) {
  const actual = evaluate(`searchTextMatches(${JSON.stringify(haystack)}, ${JSON.stringify(query)})`);
  assert.equal(actual, expected, name);
}

const exactScore = evaluate(`globalSearchScore('Evan Sampleton', 'Evan Sampleton London', globalSearchTokens('Evan Sampleton'))`);
const fuzzyScore = evaluate(`globalSearchScore('Evan Sampleton', 'Evan Sampleton London', globalSearchTokens('Evan Sampletno'))`);
assert.ok(exactScore > fuzzyScore, 'exact title match must outrank fuzzy title match');

context.sampleResults = [
  ...Array.from({ length:8 }, (_, index) => ({ group:'客户', id:`c${index}`, score:100 - index })),
  ...Array.from({ length:9 }, (_, index) => ({ group:'订单', id:`o${index}`, score:90 - index })),
  ...Array.from({ length:7 }, (_, index) => ({ group:'物流', id:`t${index}`, score:80 - index })),
  ...Array.from({ length:6 }, (_, index) => ({ group:'功能入口', id:`p${index}`, score:70 - index }))
];
const limited = evaluate('limitGlobalSearchResultsByGroup(sampleResults, 5)');
const counts = Object.fromEntries(['客户', '订单', '物流', '功能入口'].map(group => [group, limited.filter(item => item.group === group).length]));
assert.deepEqual(counts, { 客户:5, 订单:5, 物流:5, 功能入口:5 });
assert.deepEqual(evaluate('globalSearchGroupCounts(sampleResults)'), { 客户:8, 订单:9, 物流:7, 功能入口:6 });

assert.match(html, /id="page-search-results"/);
assert.match(html, /id="fullSearchInput"/);
assert.match(html, /id="fullSearchResultGroups"/);
assert.match(html, /查看全部搜索结果/);
assert.match(html, /function openFullSearchResults\(/);
assert.match(html, /function renderFullSearchResults\(/);

console.log('Global search tests passed.');
