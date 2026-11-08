// Tải nền cho thí nghiệm AIOps / chaos: 80% duyệt hàng, 15% giỏ hàng, 5% đặt hàng COD.
//   docker run --rm --network host -e API=http://localhost:8080/api -v $PWD/tests/load:/s grafana/k6 run /s/k6-shop.js
// Trên cụm: chạy như Job (k6-operator) trỏ vào ingress; biến RATE điều chỉnh req/s.
import http from 'k6/http';
import { check, sleep } from 'k6';

const API = __ENV.API || 'http://localhost:8080/api';
const RATE = Number(__ENV.RATE || 20);
const DURATION = __ENV.DURATION || '10m';

export const options = {
  scenarios: {
    browse: { executor: 'constant-arrival-rate', rate: Math.round(RATE * 0.8), timeUnit: '1s', duration: DURATION, preAllocatedVUs: 20, exec: 'browse' },
    cart: { executor: 'constant-arrival-rate', rate: Math.max(1, Math.round(RATE * 0.15)), timeUnit: '1s', duration: DURATION, preAllocatedVUs: 10, exec: 'cart' },
    checkout: { executor: 'constant-arrival-rate', rate: Math.max(1, Math.round(RATE * 0.05)), timeUnit: '1s', duration: DURATION, preAllocatedVUs: 10, exec: 'checkout' },
  },
  thresholds: {
    'http_req_failed{scenario:browse}': ['rate<0.02'],
    'http_req_duration{scenario:browse}': ['p(95)<800'],
    'http_req_duration{scenario:checkout}': ['p(95)<2000'],
  },
};

const json = { headers: { 'content-type': 'application/json' } };
const auth = (t) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });
const QUERIES = ['ao thun', 'tai nghe', 'laptop', 'vay', 'giay', 'son', 'sac du phong'];

export function setup() {
  const users = [];
  for (let i = 0; i < 10; i++) {
    const email = `k6-${Date.now()}-${i}@load.local`;
    const reg = http.post(`${API}/identity/auth/register`, JSON.stringify({ email, password: 'Matkhau@123', fullName: `K6 ${i}` }), json).json();
    http.post(`${API}/identity/auth/verify-email`, JSON.stringify({ email, code: reg.devOtp }), json);
    const login = http.post(`${API}/identity/auth/login`, JSON.stringify({ email, password: 'Matkhau@123' }), json).json();
    const addr = http.post(`${API}/user-profile/me/addresses`, JSON.stringify({ fullName: 'K6', phone: '0900000000', line1: '1 Test', ward: 'P1', district: 'Q1', province: 'Hồ Chí Minh', isDefault: true }), auth(login.accessToken)).json();
    users.push({ token: login.accessToken, addressId: addr.id });
  }
  const products = http.get(`${API}/catalog/products?pageSize=50`).json().items || [];
  const skus = products.flatMap((p) => p.variants.map((v) => ({ skuId: v.id, slug: p.slug })));
  return { users, skus };
}

export function browse(data) {
  const r1 = http.get(`${API}/bff/home`, { tags: { name: 'bff_home' } });
  check(r1, { 'home 200': (r) => r.status === 200 });
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  http.get(`${API}/search/search?q=${encodeURIComponent(q)}`, { tags: { name: 'search' } });
  if (data.skus.length) {
    const s = data.skus[Math.floor(Math.random() * data.skus.length)];
    check(http.get(`${API}/bff/products/${s.slug}`, { tags: { name: 'bff_product' } }), { 'product 200': (r) => r.status === 200 });
  }
  sleep(0.2);
}

export function cart(data) {
  if (!data.skus.length) return;
  const u = data.users[Math.floor(Math.random() * data.users.length)];
  const s = data.skus[Math.floor(Math.random() * data.skus.length)];
  http.post(`${API}/cart/cart/items`, JSON.stringify({ skuId: s.skuId, qty: 1 }), { ...auth(u.token), tags: { name: 'cart_add' } });
  http.get(`${API}/cart/cart`, { ...auth(u.token), tags: { name: 'cart_get' } });
}

export function checkout(data) {
  if (!data.skus.length) return;
  const u = data.users[Math.floor(Math.random() * data.users.length)];
  const s = data.skus[Math.floor(Math.random() * data.skus.length)];
  const r = http.post(
    `${API}/order/checkout`,
    JSON.stringify({ items: [{ skuId: s.skuId, qty: 1 }], addressId: u.addressId, paymentMethod: 'COD' }),
    { headers: { ...auth(u.token).headers, 'idempotency-key': `${__VU}-${__ITER}-${Date.now()}` }, tags: { name: 'checkout' } },
  );
  check(r, { 'checkout accepted': (x) => x.status === 200 || x.status === 201 || x.status === 409 });
}
