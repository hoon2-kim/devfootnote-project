import { createServer } from 'node:http';

createServer((req, res) => {
  req.resume();
  res.setHeader('content-type', 'application/json');

  if (req.method === 'POST' && req.url === '/token') {
    res.end(JSON.stringify({ access_token: 'fixture-google-access-token', token_type: 'Bearer' }));
  } else if (req.method === 'GET' && req.url?.startsWith('/userinfo')) {
    res.end(JSON.stringify({ sub: 'fixture-owner', name: 'Test owner' }));
  } else {
    res.writeHead(404).end();
  }
}).listen(8080, '0.0.0.0');
