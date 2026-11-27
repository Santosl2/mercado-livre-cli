// Integração com a API do Mercado Livre
// Uso:
//   node --env-file=.env apiml.js item MLB6149535370        (anúncio: só seus ou de app certificado)
//   node --env-file=.env apiml.js produto MLB54982411        (produto de catálogo)
//   node --env-file=.env apiml.js categoria MLB1055 [limit]  (mais vendidos da categoria)
//
// Autenticação:
//   ML_ACCESS_TOKEN=APP_USR-...            -> usa o token direto
//   ML_CLIENT_ID=... ML_CLIENT_SECRET=...  -> gera token via client_credentials
// Opcional: ML_SITE_ID (padrão MLB = Brasil)
//
// Restrições atuais da API para apps não certificados:
//   - GET /items/{id} de anúncios de terceiros -> 403 access_denied
//   - GET /sites/{site}/search                 -> 403 forbidden
// Por isso a busca por categoria usa /highlights + /products (catálogo).

const BASE_URL = 'https://api.mercadolibre.com';
const SITE_ID = process.env.ML_SITE_ID || 'MLB';

let tokenCache = { value: process.env.ML_ACCESS_TOKEN || null, expiresAt: Infinity };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const { ML_CLIENT_ID, ML_CLIENT_SECRET } = process.env;
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) return null;

  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new MLError('Falha ao obter access token', res.status, data);

  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // renova 60s antes
  };
  return tokenCache.value;
}

class MLError extends Error {
  constructor(message, status, body) {
    super(`${message} (HTTP ${status})${body?.message ? `: ${body.message}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

async function request(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const headers = { Accept: 'application/json' };
  const token = await getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // 429 = limite de requisições: espera e tenta de novo (até 3 vezes, 0,5s / 1s / 2s)
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new MLError(`Erro em GET ${url.pathname}`, res.status, body);
    return body;
  }
}

// ---------- Itens (anúncios) ----------

/** Anúncio pelo ID. Só funciona para anúncios próprios ou apps certificados. */
async function getItemById(itemId) {
  return request(`/items/${encodeURIComponent(itemId)}`);
}

/** Descrição do anúncio (liberada mesmo para anúncios de terceiros). */
async function getItemDescription(itemId) {
  const data = await request(`/items/${encodeURIComponent(itemId)}/description`);
  return data.plain_text || data.text || '';
}

// ---------- Produtos de catálogo ----------

/** Produto de catálogo pelo ID (ex: MLB54982411). */
async function getProductById(productId) {
  return request(`/products/${encodeURIComponent(productId)}`);
}

// ---------- Categorias ----------

// Categorias mudam raramente: cache em memória por 1h (evita 429 na descoberta de domínios)
const categoryCache = new Map();
const CATEGORY_TTL = 60 * 60 * 1000;

/** Dados da categoria (nome, caminho, total de itens). */
async function getCategory(categoryId) {
  const hit = categoryCache.get(categoryId);
  if (hit && Date.now() - hit.at < CATEGORY_TTL) return hit.promise;
  const promise = request(`/categories/${encodeURIComponent(categoryId)}`);
  categoryCache.set(categoryId, { at: Date.now(), promise });
  promise.catch(() => categoryCache.delete(categoryId));
  return promise;
}

/** Categorias raiz do site (~30). */
async function listRootCategories() {
  return request(`/sites/${SITE_ID}/categories`);
}

/** Subcategorias diretas de uma categoria. */
async function listSubcategories(categoryId) {
  return (await getCategory(categoryId)).children_categories || [];
}

/**
 * Árvore completa de categorias do site (~12 mil) em uma única requisição.
 * Retorna um array: { id, name, path, isLeaf, totalItems }.
 */
async function listAllCategories() {
  const dump = await request(`/sites/${SITE_ID}/categories/all`);
  return Object.values(dump).map((c) => ({
    id: c.id,
    name: c.name,
    path: c.path_from_root.map((p) => p.name).join(' > '),
    isLeaf: !c.children_categories?.length,
    totalItems: c.total_items_in_this_category,
  }));
}

/** IDs dos mais vendidos da categoria (produtos de catálogo e/ou anúncios). */
async function getCategoryHighlights(categoryId) {
  const data = await request(`/highlights/${SITE_ID}/category/${encodeURIComponent(categoryId)}`);
  return data.content || [];
}

/** Mais vendidos da categoria, já com os dados de cada produto. */
async function getBestSellersByCategory(categoryId, { limit = 10 } = {}) {
  const highlights = (await getCategoryHighlights(categoryId)).slice(0, limit);

  // USER_PRODUCT (/user-products/{id}) é sempre bloqueado para apps não certificados: nem tenta.
  const results = await Promise.allSettled(
    highlights.map((h) => {
      if (h.type === 'PRODUCT') return getProductById(h.id);
      if (h.type === 'ITEM') return getItemById(h.id);
      return Promise.reject(new Error('Sem acesso a este tipo de anúncio'));
    }),
  );

  return results.map((r, i) => ({
    position: highlights[i].position,
    type: highlights[i].type,
    ...(r.status === 'fulfilled'
      ? formatProduct(r.value)
      : { id: highlights[i].id, permalink: publicLink(highlights[i]), error: r.reason.message }),
  }));
}

// ---------- Produtos por categoria (catálogo) ----------

/** Busca no catálogo de produtos. Exige `q`; `domainId` restringe o tipo de produto. */
async function searchProducts(q, { domainId, limit = 20, offset = 0 } = {}) {
  const data = await request('/products/search', {
    status: 'active',
    site_id: SITE_ID,
    q,
    domain_id: domainId,
    limit,
    offset,
  });
  return {
    total: data.paging?.total ?? 0,
    offset,
    limit,
    items: (data.results || []).map(formatProduct),
  };
}

/** Sugere domínios (tipos de produto) e categorias a partir de um texto. */
async function discoverDomains(q, { limit = 8 } = {}) {
  return request(`/sites/${SITE_ID}/domain_discovery/search`, { q, limit });
}

/**
 * Domínios que pertencem à categoria (ou a uma subcategoria dela).
 * O ML não tem rota "categoria -> domínios", então descobre pelo nome da categoria
 * e descarta sugestões de fora da árvore (ex: "Animais" sugere livros e pelúcias).
 */
async function getCategoryDomains(categoryId) {
  const category = await getCategory(categoryId);
  const suggestions = await discoverDomains(category.name);

  const otherIds = [...new Set(suggestions.map((s) => s.category_id))].filter((id) => id !== categoryId);
  const others = await Promise.all(otherIds.map((id) => getCategory(id).catch(() => null)));
  const insideTree = new Set([categoryId]);
  for (const c of others) {
    if (c?.path_from_root.some((p) => p.id === categoryId)) insideTree.add(c.id);
  }

  const domains = new Map();
  for (const s of suggestions) {
    if (insideTree.has(s.category_id) && !domains.has(s.domain_id)) {
      domains.set(s.domain_id, { id: s.domain_id, name: s.domain_name, categoryId: s.category_id });
    }
  }
  return { category, domains: [...domains.values()] };
}

/**
 * Produtos de catálogo de uma categoria (não só os mais vendidos), com paginação.
 * Retorna { category, domain, domains, total, offset, limit, items }.
 * Se a categoria não tiver um domínio próprio (ex: "Outros"), retorna items vazio e `reason`.
 */
async function getProductsByCategory(categoryId, { domainId, limit = 20, offset = 0 } = {}) {
  const { category, domains } = await getCategoryDomains(categoryId);
  const base = { categoryId, domains, total: 0, offset, limit, items: [] };

  const domain = domains.find((d) => d.id === domainId) || domains[0];
  if (!domain) {
    return { ...base, domain: null, reason: 'Esta categoria não tem um tipo de produto próprio no catálogo.' };
  }

  // O nome do domínio ("Celulares") dá resultados melhores que o da categoria
  // ("Celulares e Smartphones" casa com títulos genéricos). Se não achar nada, tenta o outro.
  let result = await searchProducts(domain.name, { domainId: domain.id, limit, offset });
  if (!result.total && domain.name !== category.name) {
    result = await searchProducts(category.name, { domainId: domain.id, limit, offset });
  }
  if (!result.total) {
    return { ...base, domain, reason: `O catálogo não tem produtos do tipo "${domain.name}".` };
  }
  return { ...base, ...result, domain };
}

/** Link público no site para um destaque (produto, anúncio ou user product). */
function publicLink({ id, type }) {
  if (type === 'PRODUCT') return `https://www.mercadolivre.com.br/p/${id}`;
  if (type === 'USER_PRODUCT') return `https://www.mercadolivre.com.br/up/${id}`;
  return `https://produto.mercadolivre.com.br/${id.replace(/^([A-Z]+)(\d+)$/, '$1-$2')}`;
}

function formatProduct(p) {
  return {
    id: p.id,
    title: p.name ?? p.title,
    price: p.buy_box_winner?.price ?? p.price ?? null,
    domain: p.domain_id,
    picture: p.pictures?.[0]?.url ?? p.thumbnail ?? null,
    permalink: p.permalink || `https://www.mercadolivre.com.br/p/${p.id}`,
  };
}

module.exports = {
  getItemById,
  getItemDescription,
  getProductById,
  searchProducts,
  discoverDomains,
  getCategoryDomains,
  getProductsByCategory,
  getCategory,
  listRootCategories,
  listSubcategories,
  listAllCategories,
  getCategoryHighlights,
  getBestSellersByCategory,
  MLError,
};

// ---------- CLI ----------
if (require.main === module) {
  const [cmd, arg, ...rest] = process.argv.slice(2);

  (async () => {
    switch (cmd) {
      case 'item': {
        try {
          console.log(await getItemById(arg));
        } catch (err) {
          if (err.status !== 403) throw err;
          console.warn('Sem acesso ao anúncio (restrição da API para apps não certificados).');
          console.log('Descrição:\n' + (await getItemDescription(arg)));
        }
        break;
      }
      case 'produto':
        console.log(formatProduct(await getProductById(arg)));
        break;
      case 'categoria': {
        const limit = Number(rest[0]) || 10;
        const [category, items] = await Promise.all([
          getCategory(arg),
          getBestSellersByCategory(arg, { limit }),
        ]);
        console.log(`Categoria: ${category.path_from_root.map((c) => c.name).join(' > ')}`);
        console.table(items, ['position', 'id', 'title', 'price']);
        break;
      }
      case 'categorias': {
        // categorias            -> raiz
        // categorias MLB1051    -> subcategorias
        // categorias all [txt]  -> todas (filtra por texto no caminho; --json salva em arquivo)
        if (!arg) {
          console.table(await listRootCategories());
        } else if (arg === 'all') {
          let all = await listAllCategories();
          const filtro = rest.find((r) => r !== '--json');
          if (filtro) {
            const f = filtro.toLowerCase();
            all = all.filter((c) => c.path.toLowerCase().includes(f));
          }
          if (rest.includes('--json')) {
            require('node:fs').writeFileSync('categorias-ml.json', JSON.stringify(all, null, 2));
            console.log(`${all.length} categorias salvas em categorias-ml.json`);
          } else {
            console.table(all, ['id', 'path', 'isLeaf']);
            console.log(`${all.length} categorias`);
          }
        } else {
          console.table(await listSubcategories(arg));
        }
        break;
      }
      default:
        console.log(
          'Uso: node apiml.js <item ID | produto ID | categoria ID [limit] | categorias [ID | all [filtro] [--json]]>',
        );
        process.exitCode = 1;
    }
  })().catch((err) => {
    console.error(err.message);
    if (err.body) console.error(err.body);
    process.exitCode = 1;
  });
}
