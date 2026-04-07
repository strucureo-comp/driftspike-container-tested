## Frontend – React dashboard

The React dashboard gives you a single screen to enter `domain`, `mailHost`, the public IP, and selector. It uses the backend `/api/setup` endpoint to fetch DNS records, DKIM keys, and the Docker Compose snippet, then displays them side by side for quick copying.

### Scripts

- `npm run dev` – starts Vite on port 5173 and proxies `/api` calls to the backend.
- `npm run build` – bundles an optimized production artifact.
- `npm run preview` – serves the production build locally.
- `npm run lint` – runs ESLint across `src`.

### Notes

- Keep the backend running on port 4000 (or change the proxy in `vite.config.js`).
- Install dependencies with `npm install` from `frontend/` before running the scripts.
