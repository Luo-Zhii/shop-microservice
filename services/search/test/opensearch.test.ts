// Không có OpenSearch ở local → chỉ kiểm phần dựng mapping / truy vấn / đọc kết quả (thuần).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody, buildSuggestBodies, parseSearchResponse, productIndexBody, toIndexDoc } from '../src/engines/opensearch';
import { parseSearchQuery } from '../src/routes';
import type { SearchDoc } from '../src/types';

type Any = Record<string, any>;

test('mapping: analyzer asciifolding + edge_ngram cho suggest', () => {
  const b = productIndexBody() as Any;
  const an = b.settings.analysis;
  assert.deepEqual(an.analyzer.vi_folding.filter, ['lowercase', 'asciifolding']);
  assert.ok(an.analyzer.vi_autocomplete.filter.includes('autocomplete_edge'));
  assert.equal(an.filter.autocomplete_edge.type, 'edge_ngram');
  const title = b.mappings.properties.title;
  assert.equal(title.analyzer, 'vi_folding');
  assert.equal(title.fields.suggest.analyzer, 'vi_autocomplete');
  assert.equal(title.fields.suggest.search_analyzer, 'vi_folding');
  assert.equal(b.mappings.properties.categoryIds.type, 'keyword');
});

test('toIndexDoc: categoryFacet "id|tên" song song chuỗi danh mục', () => {
  const d: SearchDoc = {
    id: 'p1', slug: 'ao', title: 'Áo', brand: null, shopId: 's', shopName: 'S', categoryId: 'c2', categoryIds: ['c1', 'c2'],
    categoryNames: ['Thời trang', 'Áo'], image: null, minPrice: 1, maxPrice: 2, ratingAvg: 0, ratingCount: 0, soldCount: 0,
    skuIds: ['k'], attributesText: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const doc = toIndexDoc(d, false);
  assert.deepEqual(doc.categoryFacet, ['c1|Thời trang', 'c2|Áo']);
  assert.equal(doc.categoryText, 'Thời trang Áo');
  assert.equal(doc.inStock, false);
});

test('buildSearchBody: bool fuzzy + filter + post_filter giá + aggs + sort + phân trang', () => {
  const q = parseSearchQuery({ q: 'áo thun', categoryId: 'c1', shopId: 's1', minPrice: '100000', maxPrice: '500000', rating: '4', inStock: 'true', sort: 'relevance', page: '3', pageSize: '10' });
  const b = buildSearchBody(q) as Any;
  assert.equal(b.from, 20);
  assert.equal(b.size, 10);
  const mm = b.query.bool.must[0].multi_match;
  assert.equal(mm.query, 'áo thun');
  assert.equal(mm.fuzziness, 'AUTO');
  assert.equal(mm.operator, 'and');
  assert.ok(mm.fields.includes('title^3'));
  assert.equal(b.query.bool.should[0].match_phrase.title.query, 'áo thun');
  assert.deepEqual(b.query.bool.filter, [
    { term: { categoryIds: 'c1' } },
    { term: { shopId: 's1' } },
    { range: { ratingAvg: { gte: 4 } } },
    { term: { inStock: true } },
  ]);
  assert.deepEqual(b.post_filter, { range: { minPrice: { gte: 100_000, lte: 500_000 } } });
  assert.deepEqual(b.aggs.categories.filter, b.post_filter, 'facet danh mục áp cùng bộ lọc giá');
  assert.equal(b.aggs.categories.aggs.items.terms.field, 'categoryFacet');
  assert.equal(b.aggs.priceRanges.range.field, 'minPrice');
  assert.equal(b.aggs.priceRanges.range.ranges.length, 6);
  assert.deepEqual(b.aggs.priceRanges.range.ranges[0], { key: '0-100000', to: 100_000 });
  assert.deepEqual(b.aggs.priceRanges.range.ranges[5], { key: '5000000-', from: 5_000_000 });
  assert.deepEqual(b.sort, ['_score', { soldCount: 'desc' }]);
});

test('buildSearchBody: không có q → match_all, sort theo hợp đồng', () => {
  const sorts: Record<string, unknown> = {
    relevance: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
    price_asc: [{ minPrice: 'asc' }, { soldCount: 'desc' }],
    price_desc: [{ minPrice: 'desc' }, { soldCount: 'desc' }],
    newest: [{ createdAt: 'desc' }],
    best_selling: [{ soldCount: 'desc' }, { ratingAvg: 'desc' }],
  };
  for (const [sort, expected] of Object.entries(sorts)) {
    const b = buildSearchBody(parseSearchQuery({ sort })) as Any;
    assert.deepEqual(b.query.bool.must, [{ match_all: {} }]);
    assert.equal(b.post_filter, undefined);
    assert.deepEqual(b.sort, expected, sort);
  }
});

test('buildSuggestBodies: edge_ngram trên title.suggest + truy vấn phổ biến', () => {
  const b = buildSuggestBodies('ao th', 5) as Any;
  assert.equal(b.products.size, 5);
  assert.equal(b.products.query.bool.should[0].match['title.suggest'].query, 'ao th');
  assert.equal(b.queries.query.match['q.suggest'].query, 'ao th');
  const empty = buildSuggestBodies('', 5) as Any;
  assert.deepEqual(empty.queries.query, { match_all: {} });
  assert.deepEqual(empty.queries.sort, [{ hits: 'desc' }]);
});

test('parseSearchResponse: hits + facets', () => {
  const r = parseSearchResponse({
    hits: { total: { value: 42 }, hits: [{ _id: 'p1', _source: { id: 'p1', slug: 'ao', title: 'Áo', minPrice: 100, maxPrice: 200, inStock: true } }] },
    aggregations: {
      categories: { doc_count: 42, items: { buckets: [{ key: 'c1|Thời trang', doc_count: 40 }, { key: 'c2|Áo|thun', doc_count: 2 }] } },
      priceRanges: { buckets: { '0-100000': { doc_count: 3 }, '100000-200000': { doc_count: 39 } } },
    },
  });
  assert.equal(r.total, 42);
  assert.equal(r.items[0].title, 'Áo');
  assert.deepEqual(r.facets.categories, [{ id: 'c1', name: 'Thời trang', count: 40 }, { id: 'c2', name: 'Áo|thun', count: 2 }]);
  assert.equal(r.facets.priceRanges.find((p) => p.key === '100000-200000')!.count, 39);
  assert.equal(r.facets.priceRanges.find((p) => p.key === '5000000-')!.count, 0);
});
