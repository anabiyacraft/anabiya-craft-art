// Firestore থেকে পণ্য পড়ে products.html, images/ ও sitemap.xml বানায়।
// GitHub Actions এটা নিজে নিজে চালায়। হাতে কিছু করতে হয় না।
import fs from 'node:fs';
import path from 'node:path';

// ===================== আপনার সেটিংস =====================
const SITE = 'https://anabiyacraft.shop/';
const PROJECT = 'adda-a955e';
const API_KEY = 'AIzaSyAdJH1iWcLLe0fA8xAuZkONvR4wT7SQnqI';
const BRAND = 'Anabiya Craft & Art';

// রিটার্ন নীতি: 'none' = ফেরত নেওয়া হয় না, 'days' = নির্দিষ্ট দিনের মধ্যে ফেরত নেওয়া হয়
// (Google-কে এটা আপনার আসল নিয়ম হিসেবে জানানো হবে, তাই সত্যিটা বাছুন)
const RETURN_POLICY = 'none';
const RETURN_DAYS = 7;

const HANDLING_DAYS = [1, 2];   // অর্ডার প্রস্তুত করতে (সর্বনিম্ন, সর্বোচ্চ) দিন
const TRANSIT_DAYS = [2, 5];    // কুরিয়ারে পৌঁছাতে (সর্বনিম্ন, সর্বোচ্চ) দিন
const DEFAULT_DELIVERY_FIRST = 130; // অ্যাডমিনের সাধারণ রেট না পেলে এটা ধরা হবে
// ========================================================

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function dec(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}
function decDoc(d) {
  const o = { id: d.name.split('/').pop() };
  for (const [k, v] of Object.entries(d.fields || {})) o[k] = dec(v);
  return o;
}
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()));
  return r.json();
}
async function listProducts() {
  const out = [];
  let token = '';
  do {
    const j = await getJson(`${BASE}/products?pageSize=300&key=${API_KEY}` + (token ? `&pageToken=${encodeURIComponent(token)}` : ''));
    (j.documents || []).forEach(d => out.push(decDoc(d)));
    token = j.nextPageToken || '';
  } while (token);
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const bn = n => Number(n).toLocaleString('bn-BD');
const extOf = mime => ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg');

const products = await listProducts();
if (!products.length) {
  console.error('কোনো পণ্য পাওয়া যায়নি, তাই ফাইল বদলানো হয়নি।');
  process.exit(1);
}

let globalFirst = DEFAULT_DELIVERY_FIRST;
try {
  const d = decDoc(await getJson(`${BASE}/settings/delivery?key=${API_KEY}`));
  if (typeof d.first === 'number') globalFirst = d.first;
} catch (e) { console.log('সাধারণ ডেলিভারি রেট পাওয়া যায়নি, ডিফল্ট ব্যবহার হচ্ছে'); }

// ---------- ছবি ----------
fs.mkdirSync('images', { recursive: true });
const keep = new Set();
for (const p of products) {
  const list = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
  const first = list[0] || '';
  p._imgRel = null;
  p._imgAbs = null;
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/s.exec(first);
  if (m) {
    const file = `${p.id}.${extOf(m[1])}`;
    fs.writeFileSync(path.join('images', file), Buffer.from(m[2], 'base64'));
    keep.add(file);
    p._imgRel = 'images/' + file;
    p._imgAbs = SITE + 'images/' + file;
  } else if (/^https?:\/\//.test(first)) {
    p._imgRel = p._imgAbs = first;
  }
}
for (const f of fs.readdirSync('images')) if (!keep.has(f)) fs.unlinkSync(path.join('images', f));

// ---------- স্ট্রাকচার্ড ডেটা ----------
const returnPolicy = { '@type': 'MerchantReturnPolicy', applicableCountry: 'BD' };
if (RETURN_POLICY === 'days') {
  Object.assign(returnPolicy, {
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: RETURN_DAYS,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility'
  });
} else {
  returnPolicy.returnPolicyCategory = 'https://schema.org/MerchantReturnNotPermitted';
}
const days = ([min, max]) => ({ '@type': 'QuantitativeValue', minValue: min, maxValue: max, unitCode: 'DAY' });
const deliveryTime = { '@type': 'ShippingDeliveryTime', handlingTime: days(HANDLING_DAYS), transitTime: days(TRANSIT_DAYS) };

const hasOffer = p => Number(p.offerPrice) > 0 && Number(p.offerPrice) < Number(p.price);
const effPrice = p => hasOffer(p) ? Number(p.offerPrice) : Number(p.price);

const ldItems = products.map((p, i) => {
  const url = `${SITE}?product=${encodeURIComponent(p.id)}`;
  const item = {
    '@type': 'Product', name: p.name, url,
    brand: { '@type': 'Brand', name: BRAND },
    offers: {
      '@type': 'Offer', url, price: String(effPrice(p)), priceCurrency: 'BDT',
      availability: 'https://schema.org/InStock',
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: typeof p.deliveryFirst === 'number' ? p.deliveryFirst : globalFirst, currency: 'BDT' },
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'BD' },
        deliveryTime
      },
      hasMerchantReturnPolicy: returnPolicy
    }
  };
  if (p._imgAbs) item.image = p._imgAbs;
  if (p.description) item.description = String(p.description).slice(0, 300);
  return { '@type': 'ListItem', position: i + 1, item };
});
const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: ldItems }, null, 2).replace(/<\//g, '<\\/');

// ---------- products.html ----------
const cards = products.map(p => {
  const price = hasOffer(p)
    ? `<s>৳${bn(p.price)}</s> ৳${bn(p.offerPrice)}`
    : `৳${bn(p.price)}`;
  return `    <a class="card" href="/?product=${encodeURIComponent(p.id)}">
      ${p._imgRel ? `<img src="${esc(p._imgRel)}" alt="${esc(p.name)}" loading="lazy">` : ''}
      <h2>${esc(p.name)}</h2>
      <p class="price">${price}</p>
    </a>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>সব পণ্য | ${esc(BRAND)}</title>
<meta name="description" content="${esc(BRAND)}-এর হাতে তৈরি সব ক্রাফট ও আর্ট পণ্যের তালিকা ও দাম। সারা বাংলাদেশে হোম ডেলিভারি।">
<link rel="canonical" href="${SITE}products.html">
<link href="https://fonts.googleapis.com/css2?family=Anek+Bangla:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Anek Bangla','Segoe UI',Arial,sans-serif;background:#f2f6f5;color:#12302b}
  header{padding:14px 20px;background:#fff;border-bottom:1px solid #d9e4e1}
  header a{color:#0f6b62;font-weight:700;text-decoration:none}
  main{max-width:1180px;margin:0 auto;padding:20px}
  h1{font-size:26px;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
  .card{background:#fff;border:1px solid #d9e4e1;border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;display:block}
  .card img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;background:#e6eeec}
  .card h2{font-size:15px;padding:12px 12px 4px}
  .price{padding:0 12px 14px;font-weight:800}
  .price s{opacity:.55;font-weight:600;margin-right:6px}
  footer{text-align:center;padding:24px;font-size:13px;color:#5d716d}
  @media(max-width:600px){.grid{grid-template-columns:repeat(2,1fr);gap:10px}}
</style>
<script type="application/ld+json">
${ld}
</script>
</head>
<body>
<header><a href="/">← ${esc(BRAND)}</a></header>
<main>
  <h1>আমাদের সব পণ্য</h1>
  <div class="grid">
${cards}
  </div>
</main>
<footer>© ${esc(BRAND)} · অর্ডার করতে পণ্যে ক্লিক করুন</footer>
</body>
</html>
`;
fs.writeFileSync('products.html', html);

// ---------- sitemap ----------
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${SITE}products.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>
</urlset>
`);
console.log(`সম্পন্ন: ${products.length}টি পণ্য`);
