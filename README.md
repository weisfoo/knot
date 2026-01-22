# Knot

Sailing conditions aggregator for wind, weather, tides, and marine model data.

## Run locally (FastAPI)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 3000
```

Open http://localhost:3000

## Free-tier deployment (reliable + scalable)

This setup works well on Render or Fly.io and can scale later without changing code.

### Render (simplest)
1. Create a new Web Service from your repo.
2. Build command: `pip install -r requirements.txt`
3. Start command: `uvicorn main:app --host 0.0.0.0 --port 10000`
4. Use the free tier and scale up when needed.

### GitHub Pages + Render (free frontend + free backend)
GitHub Pages only serves static files. Use Render for the API and GitHub Pages for the UI.

1. Deploy the API to Render and note the public URL (for example `https://knot-api.onrender.com`).
2. Set `window.KNOT_API_BASE` in `public/config.js` to that URL.
3. Run `scripts/publish_pages.sh` to copy `public/` into `docs/`.
4. Enable GitHub Pages on the `docs/` folder in repo settings.
5. (Optional) Add a custom domain in GitHub Pages settings.

For a custom domain with Cloudflare:
- UI: `knot.yourdomain.com` -> CNAME to your GitHub Pages domain.
- API: `api.knot.yourdomain.com` -> CNAME to your Render URL.

### Fly.io (more control)
1. Install Fly CLI locally.
2. Run `fly launch`.
3. Deploy with `fly deploy`.

## Cloudflare domain
- Add a CNAME record pointing your domain/subdomain to the Render or Fly hostname.
- Enable Cloudflare proxy if you want HTTPS and caching.

## Customize spots
Edit `data/spots.json` to add your favorite sailing spots. Add a NOAA tide station id if you want tide predictions per spot.

## Data sources
- Open-Meteo forecast: wind, temperature, weather codes.
- Open-Meteo marine: wave height, period, direction.
- NOAA CO-OPS: tide predictions (optional per spot).

Notes:
- Some data providers require a key or paid plan for higher usage.
- Marine model parameters vary by region; update `main.py` if you want different fields.
# knot
