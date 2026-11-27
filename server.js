// Servidor local para o index.html.
// O navegador não pode chamar a API do Mercado Livre direto (o CLIENT_SECRET ficaria exposto),
// então este servidor serve os arquivos estáticos e repassa as consultas.
//
//   node --env-file=.env server.js        -> http://localhost:3000
//   PORT=8080 node --env-file=.env server.js

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ml = require('./apiml');

const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL = 10 * 60 * 1000; // 10 min
const cache = new Map();

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/categorias-ml.json': { file: 'categorias-ml.json', type: 'application/json; charset=utf-8' },
};

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const asset = STATIC[url.pathname];
  if (asset) {
    const stream = fs.createReadStream(path.join(__dirname, asset.file));
    stream.on('error', () => sendJson(res, 404, { error: `${asset.file} não encontrado` }));
    res.writeHead(200, { 'Content-Type': asset.type });
    return stream.pipe(res);
  }

  // GET /api/categorias/:id/itens?limit=20
  const match = url.pathname.match(/^\/api\/categorias\/([A-Z]{3}\d+)\/itens$/);
  if (match && req.method === 'GET') {
    const id = match[1];
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);
    try {
      const items = await cached(`itens:${id}:${limit}`, () =>
        ml.getBestSellersByCategory(id, { limit }),
      );
      return sendJson(res, 200, { id, items });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  // GET /api/categorias/:id/produtos?limit=20&offset=0&domain=MLB-CELLPHONES
  const prodMatch = url.pathname.match(/^\/api\/categorias\/([A-Z]{3}\d+)\/produtos$/);
  if (prodMatch && req.method === 'GET') {
    const id = prodMatch[1];
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const domainId = url.searchParams.get('domain') || undefined;
    try {
      const data = await cached(`produtos:${id}:${domainId}:${limit}:${offset}`, () =>
        ml.getProductsByCategory(id, { domainId, limit, offset }),
      );
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  sendJson(res, 404, { error: 'Rota não encontrada' });
});

server.listen(PORT, () => {
  console.log(`Explorador de categorias em http://localhost:${PORT}`);
});
