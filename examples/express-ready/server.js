import express from 'express';

const port = Number(process.env.PORT ?? 3000);
const greeting = process.env.GREETING;

if (!greeting) {
  console.error('GREETING env var is required (see .env.example).');
  process.exit(1);
}

const app = express();

app.get('/', (_req, res) => {
  res.json({ greeting, pid: process.pid });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Listening on http://127.0.0.1:${String(port)}`);
});
