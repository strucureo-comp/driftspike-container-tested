# Backend – Mail Server Configurator

This Express service generates the DNS records, DKIM key pair, and Docker Compose template required to stand up a docker-mailserver stack. It is intentionally minimal so the React dashboard can fetch structured data and keep the UI focused on choosing `domain`, `mailHost`, and `IP`.

## Available scripts

- `npm run dev` – watches `src/server.js` with `nodemon` and restarts on change.
- `npm start` – runs the server once.
- `npm run lint` – runs ESLint on `src`.

## Environment

The backend uses:

- `MAIL_DOMAIN` – default `example.com`.
- `MAIL_HOST` – default `mail`.
- `SERVER_IP` – the public IP that DNS should resolve to.
- `POSTMASTER_ADDRESS` – receives DMARC reports.

## Deployment notes

- Run `docker compose up -d` from this directory after you copy `docker-compose.yml`.
- Mount your DKIM private key (`dkim.key`) at `./config/opendkim/keys/{domain}.private`.
- Copy the JSON response from `/api/setup` into a `.env` template before starting the stack.
