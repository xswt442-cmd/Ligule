import { createServer } from 'node:http';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createItemServer() {
  const items = new Map([['item-1', { id: 'item-1', name: 'Tea' }]]);

  return createServer(async (request, response) => {
    const route = /^\/api\/items\/([^/]+)$/u.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (route === null) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    const id = decodeURIComponent(route[1]);
    const item = items.get(id);
    if (request.method === 'GET') {
      sendJson(response, item === undefined ? 404 : 200, item ?? { error: 'not_found' });
      return;
    }
    if (request.method !== 'PATCH') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (item === undefined) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    let body;
    try { body = await readJson(request); }
    catch {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '' || name.length > 80) {
      sendJson(response, 400, { error: 'invalid_name' });
      return;
    }

    const updated = { ...item, name };
    items.set(id, updated);
    sendJson(response, 200, updated);
  });
}
