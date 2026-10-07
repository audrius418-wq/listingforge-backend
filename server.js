import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.PORT || 8080);
const MAX_ROWS = Number(process.env.MAX_ROWS || 1000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 5));
const MAX_RETRIES = Math.max(0, Number(process.env.MAX_RETRIES || 3));
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
const jobs = new Map();

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (!client) console.warn('OPENAI_API_KEY is not set. AI requests will fail until it is configured.');

app.use(cors());
app.use(express.json({ limit: '8mb' }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const transient = err => {
  const status = err?.status ?? err?.statusCode;
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599) || err?.code === 'ETIMEDOUT';
};

function cleanText(v) { return String(v ?? '').trim(); }

async function generateOne(item, platform, language) {
  if (!client) throw new Error('OPENAI_API_KEY is not configured on the server');
  const name = cleanText(item.name || item.title || item.product_name);
  const details = cleanText(item.details || item.description || item.product_details || JSON.stringify(item));
  if (!name) throw new Error('Missing product name');
  if (!details) throw new Error('Missing product details');

  const response = await client.responses.create({
    model: MODEL,
    input: [
      {
        role: 'system',
        content: 'You are an ecommerce copywriter. Create accurate product listings from supplied facts. Never invent specifications, certifications, measurements, materials, warranties, or claims that are not present in the source data.'
      },
      {
        role: 'user',
        content: `Create a ${platform} product listing in ${language}. Return ONLY valid JSON with keys title, description, bullets, seo_title, seo_description. Product name: ${name}. Product details: ${details}`
      }
    ]
  });
  const text = response.output_text?.trim();
  if (!text) throw new Error('AI returned empty output');
  try {
    const parsed = JSON.parse(text.replace(/^\`\`\`json\s*/i, '').replace(/\s*\`\`\`$/, ''));
    if (!parsed.title || !parsed.description) throw new Error('AI response missing title/description');
    return { ...item, ...parsed, bullets: Array.isArray(parsed.bullets) ? parsed.bullets.join(' | ') : String(parsed.bullets ?? '') };
  } catch {
    return { ...item, title: name, description: text, bullets: '', seo_title: '', seo_description: '' };
  }
}

async function withRetry(fn) {
  let last;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (attempt === MAX_RETRIES || !transient(err)) throw err;
      await sleep(Math.min(15000, 750 * 2 ** attempt + Math.floor(Math.random() * 400)));
    }
  }
  throw last;
}

async function processJob(job) {
  job.status = 'running';
  const results = [];
  const failed = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= job.items.length) return;
      const item = job.items[index];
      try {
        const result = await withRetry(() => generateOne(item, job.platform, job.language));
        results[index] = result;
      } catch (error) {
        failed.push({ index, item, error: error?.message || 'Generation failed' });
      }
      job.completed = results.filter(Boolean).length + failed.length;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, job.items.length) }, worker));
  job.results = results.filter(Boolean);
  job.failed = failed.sort((a,b) => a.index - b.index);
  job.status = 'completed';
  job.finishedAt = new Date().toISOString();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ListingForge AI', model: MODEL }));

app.post('/api/generate', async (req, res) => {
  try {
    const { name, details, platform = 'Shopify', language = 'English' } = req.body || {};
    const result = await withRetry(() => generateOne({ name, details }, platform, language));
    res.json({ ...result, text: result.description });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'AI generation failed' });
  }
});

app.post('/api/bulk', (req, res) => {
  const { items, platform = 'Shopify', language = 'English' } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items must be a non-empty array' });
  if (items.length > MAX_ROWS) return res.status(400).json({ error: `Maximum ${MAX_ROWS} products per job.` });
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', total: items.length, completed: 0, items, platform, language, results: [], failed: [], createdAt: new Date().toISOString() };
  jobs.set(id, job);
  processJob(job).catch(error => { job.status = 'failed'; job.error = error?.message || 'Job failed'; });
  res.status(202).json({ jobId: id, status: job.status, total: job.total });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: job.id, status: job.status, total: job.total, completed: job.completed, failed: job.failed.length, error: job.error || null });
});

app.get('/api/jobs/:id/results', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') return res.status(409).json({ error: 'Job is not completed', status: job.status });
  res.json({ items: job.results, failed: job.failed });
});

app.listen(port, '0.0.0.0', () => console.log(`ListingForge AI backend listening on port ${port}`));
