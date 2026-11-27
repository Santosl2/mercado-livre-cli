# ml-api

Cliente em Node.js para a API pública do Mercado Livre. Não precisa de nenhuma dependência: usa só o `fetch` nativo do Node.

Com ele você consegue:

- consultar anúncios, produtos de catálogo e categorias;
- listar os mais vendidos de uma categoria;
- exportar a árvore completa de categorias.

Dá para usar pela linha de comando ou importar as funções no seu código.

---

## Requisitos

- **Node.js 20.6 ou mais novo**, por causa do `fetch` nativo e da opção `--env-file`. Foi testado no Node 22.
- Um **app cadastrado** no [portal de developers do Mercado Livre](https://developers.mercadolivre.com.br/), que fornece o `Client ID` e o `Client Secret`.

## Configuração

Crie um arquivo `.env` na pasta do projeto. Há duas opções.

**Opção 1 (recomendada): credenciais do app.** O token é gerado sozinho via `client_credentials` e renovado automaticamente 60 segundos antes de expirar.

```env
ML_CLIENT_ID=1234567890123456
ML_CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz
```

**Opção 2: um token pronto.** Ele não é renovado; quando expirar, você precisa trocar.

```env
ML_ACCESS_TOKEN=APP_USR-...
```

**Variável opcional:**

| Variável | Padrão | Descrição |
|---|---|---|
| `ML_SITE_ID` | `MLB` | Site do Mercado Livre: `MLB` (Brasil), `MLA` (Argentina), `MLM` (México) etc. |

> Não faça commit do `.env`. Adicione-o ao `.gitignore`.

---

## Uso pela linha de comando

Todos os comandos seguem o formato:

```bash
node --env-file=.env apiml.js <comando> [argumentos]
```

| Comando | O que faz |
|---|---|
| `item <ID>` | Dados de um anúncio. Se a API bloquear (403), mostra só a descrição. |
| `produto <ID>` | Produto de catálogo: nome, preço, domínio, foto e link. |
| `categoria <ID> [limit]` | Mais vendidos da categoria (padrão: 10). |
| `categorias` | Categorias raiz do site (cerca de 30). |
| `categorias <ID>` | Subcategorias diretas de uma categoria. |
| `categorias all` | Todas as categorias, cerca de 12 mil, com o caminho completo. |
| `categorias all <texto>` | Mesma lista, filtrada pelo texto no caminho (sem diferenciar maiúsculas). |
| `categorias all [texto] --json` | Salva o resultado em `categorias-ml.json`. |

### Exemplos

```bash
# Mais vendidos de "Celulares e Smartphones"
node --env-file=.env apiml.js categoria MLB1055 5

# Produto de catálogo
node --env-file=.env apiml.js produto MLB54982411

# Anúncio
node --env-file=.env apiml.js item MLB6149535370

# Navegar pela árvore de categorias
node --env-file=.env apiml.js categorias            # raiz
node --env-file=.env apiml.js categorias MLB1051    # "Celulares e Telefones"

# Procurar categorias pelo nome
node --env-file=.env apiml.js categorias all smartwatch

# Exportar todas as categorias para JSON
node --env-file=.env apiml.js categorias all --json
```

Exemplo de saída do comando `categoria`:

```
Categoria: Celulares e Telefones > Celulares e Smartphones
┌─────────┬──────────┬───────────────┬──────────────────────────────────────────────┬───────┐
│ (index) │ position │ id            │ title                                        │ price │
├─────────┼──────────┼───────────────┼──────────────────────────────────────────────┼───────┤
│ 0       │ 1        │ 'MLB54982411' │ 'Celular Samsung Galaxy A17 Com Ia, 256gb...' │ null  │
│ 1       │ 2        │ 'MLB54961556' │ 'Smartphone Samsung Galaxy A07 4G 256GB...'   │ null  │
└─────────┴──────────┴───────────────┴──────────────────────────────────────────────┴───────┘
```

---

## Interface web

O `index.html` serve para navegar pelas categorias do `categorias-ml.json` e ver os mais vendidos de cada uma.

```bash
node --env-file=.env apiml.js categorias all --json   # gera categorias-ml.json (só na primeira vez)
node --env-file=.env server.js                        # http://localhost:3000 (mude a porta com PORT=8080)
```

- **Navegação:** à esquerda, a árvore de categorias, ordenada por número de anúncios.
- **Busca:** por nome, caminho ou ID, sem diferenciar acentos.
- **Categoria selecionada:** mostra o caminho, o total de anúncios, as subcategorias e o ranking dos 20 mais vendidos.
- **Link direto:** cada categoria tem endereço próprio, como `http://localhost:3000/#MLB1055`.

O `server.js` existe porque o navegador não pode chamar a API direto: o `CLIENT_SECRET` ficaria exposto. Ele serve os arquivos e expõe uma rota:

| Rota | Retorno |
|---|---|
| `GET /api/categorias/:id/itens?limit=20` | `{ id, items }`, no mesmo formato de `getBestSellersByCategory`. Máximo de 50 itens, com cache de 10 minutos. |

No ranking, itens do tipo `USER_PRODUCT` e `ITEM` aparecem sem foto e sem título, porque a API bloqueia esses dados (veja as [limitações](#limitações-da-api)). O link para abrir no site continua funcionando.

---

## Uso como biblioteca

O arquivo usa CommonJS:

```js
const ml = require('./apiml');

const top = await ml.getBestSellersByCategory('MLB1055', { limit: 5 });
const categorias = await ml.listAllCategories();
```

As variáveis de ambiente precisam estar carregadas, seja com `node --env-file=.env`, `dotenv` ou `process.env`.

### Funções disponíveis

#### Anúncios

| Função | Rota da API | Retorno |
|---|---|---|
| `getItemById(itemId)` | `GET /items/{id}` | Objeto completo do anúncio. ⚠️ Veja as [limitações](#limitações-da-api). |
| `getItemDescription(itemId)` | `GET /items/{id}/description` | `string` com a descrição em texto puro. |

#### Produtos de catálogo

| Função | Rota da API | Retorno |
|---|---|---|
| `getProductById(productId)` | `GET /products/{id}` | Objeto do produto: `name`, `pictures`, `attributes`, `main_features`, `short_description`, `parent_id`, `children_ids` etc. |

#### Categorias

| Função | Rota da API | Retorno |
|---|---|---|
| `getCategory(categoryId)` | `GET /categories/{id}` | Objeto da categoria: `name`, `path_from_root`, `children_categories`, `total_items_in_this_category`, `settings`. |
| `listRootCategories()` | `GET /sites/{site}/categories` | `[{ id, name }]` |
| `listSubcategories(categoryId)` | `GET /categories/{id}` | `[{ id, name, total_items_in_this_category }]` |
| `listAllCategories()` | `GET /sites/{site}/categories/all` | `[{ id, name, path, isLeaf, totalItems }]`, cerca de 12 mil itens numa única requisição. |
| `getCategoryHighlights(categoryId)` | `GET /highlights/{site}/category/{id}` | `[{ id, position, type }]`, onde `type` é `PRODUCT` ou `ITEM`. |
| `getBestSellersByCategory(categoryId, { limit })` | highlights + `/products/{id}` | `[{ position, type, id, title, price, domain, picture, permalink }]` |

Sobre `getBestSellersByCategory`:

- Busca os detalhes de cada item em paralelo, com `Promise.allSettled`.
- Se um item falhar, ele aparece com `{ id, error }` e os outros continuam normalmente.

### Tratamento de erros

Toda falha HTTP lança um `MLError`, que estende `Error` e traz:

- `status`: o código HTTP;
- `body`: a resposta JSON da API;
- `message`: algo como `Erro em GET /items/MLB123 (HTTP 403): Access to the requested resource is forbidden`.

```js
const { getItemById, getItemDescription, MLError } = require('./apiml');

try {
  const item = await getItemById('MLB6149535370');
} catch (err) {
  if (err instanceof MLError && err.status === 403) {
    const descricao = await getItemDescription('MLB6149535370');
  } else {
    throw err;
  }
}
```

Toda requisição tem **timeout de 15 segundos**, via `AbortSignal.timeout`.

---

## Limitações da API

Desde 2025, o Mercado Livre restringe algumas rotas para apps que **não são certificados**. A tabela mostra o que testamos com um token `client_credentials` comum:

| Rota | Status | Observação |
|---|---|---|
| `GET /users/me` | ✅ 200 | |
| `GET /categories/{id}` | ✅ 200 | Funciona até sem token. |
| `GET /sites/{site}/categories` | ✅ 200 | |
| `GET /sites/{site}/categories/all` | ✅ 200 | |
| `GET /highlights/{site}/category/{id}` | ✅ 200 | |
| `GET /products/{id}` | ✅ 200 | Não traz preço: `buy_box_winner` vem `null`. |
| `GET /products/search?q=...` | ✅ 200 | Exige `q`, `product_identifier` ou `attributes`; não aceita filtrar só por categoria. Ainda não tem função no cliente. |
| `GET /items/{id}/description` | ✅ 200 | |
| `GET /items/{id}` | ❌ 403 | Liberado só para anúncios **próprios**. Anúncios de terceiros respondem `access_denied`. |
| `GET /items?ids=...` | ❌ 403 | Mesma restrição, aplicada a cada item. |
| `GET /products/{id}/items` | ❌ 403 | Ofertas de um produto, com vendedores e preços. |
| `GET /sites/{site}/search` | ❌ 403 | Busca de anúncios, inclusive por categoria. |

Na prática, isso significa que:

- **O preço não está disponível** sem certificação. O campo `price` vem `null` nos produtos de catálogo.
- **Para ver os detalhes completos de anúncios de terceiros**, como preço, estoque e vendedor, é preciso pedir a certificação do app no portal de developers. Depois disso, `getItemById` passa a funcionar sem mudar o código.
- **No lugar da busca por categoria**, o cliente usa os mais vendidos (`/highlights`).

> ⚠️ A rota `/users/me` devolve dados pessoais do dono do app, como CPF, e-mail e endereço. Não registre essa resposta em logs.

---

## IDs úteis

| ID | Categoria |
|---|---|
| `MLB1051` | Celulares e Telefones |
| `MLB1055` | Celulares e Smartphones |
| `MLB1648` | Informática |
| `MLB1000` | Eletrônicos, Áudio e Vídeo |
| `MLB1144` | Games |
| `MLB1276` | Esportes e Fitness |
| `MLB1574` | Casa, Móveis e Decoração |

Para ver a lista completa: `node --env-file=.env apiml.js categorias`.

**Formato dos IDs:**

- Anúncios e produtos começam com o código do site (`MLB...`).
- Anúncios costumam ter 10 dígitos (`MLB6149535370`); produtos de catálogo, em geral, têm 8 (`MLB54982411`).
- No link do site, o ID do produto aparece depois de `/p/`, como em `mercadolivre.com.br/p/MLB54982411`.
- O ID do anúncio aparece no link como `MLB-6149535370`. Tire o hífen antes de usar.

---

## Referências

- [Documentação oficial da API](https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br)
- [Autenticação e autorização](https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao)
- [Categorias e atributos](https://developers.mercadolivre.com.br/pt_br/categorias-e-atributos)
- [Itens e buscas](https://developers.mercadolivre.com.br/pt_br/itens-e-buscas)
