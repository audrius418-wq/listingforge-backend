# ListingForge AI backend

Real backend for ListingForge AI. Uses the OpenAI Responses API, accepts up to 1,000 catalog rows, runs controlled concurrent generation, retries transient failures up to 3 times, tracks progress, and exposes generated results.

## Run

1. Install Node.js 20+.
2. Copy .env.example to .env.
3. Set OPENAI_API_KEY in .env (never in the browser).
4. npm install
5. npm start

Endpoints:
- GET /health
- POST /api/generate
- POST /api/bulk -> returns { jobId }
- GET /api/jobs/:id
- GET /api/jobs/:id/results

For production, use a persistent queue/database instead of the in-memory jobs Map, and put the service behind HTTPS and authentication/rate limiting.
