import { createServer } from 'node:http';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createItemServer() {
  const items = new Map([['item-1', { id: 'item-1', name: 'Tea' }]]);

  return createServer((request, response) => {
    const route = /^\/api\/items\/([^/]+)$/u.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (route === null) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.method === 'GET') {
      const item = items.get(decodeURIComponent(route[1]));
      sendJson(response, item === undefined ? 404 : 200, item ?? { error: 'not_found' });
      return;
    }

    sendJson(response, 405, { error: 'method_not_allowed' });
  });
}
