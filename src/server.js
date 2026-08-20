import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import avatarRoutes from './routes/avatars.js';
import videoRoutes from './routes/videos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, apiKeyConfigured: Boolean(config.apiKey) });
});

app.use('/api', avatarRoutes);
app.use('/api', videoRoutes);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, details: err.details });
});

app.listen(config.port, () => {
  console.log(`heygen-instagram running on http://localhost:${config.port}`);
  if (!config.apiKey) console.warn('HEYGEN_API_KEY is missing — API calls will fail until you set it in .env');
});

export default app;
