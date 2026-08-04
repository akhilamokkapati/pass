# Multi-stage build: Node builds the React dashboard, Python serves it + the
# live sensor WebSocket. See webapp/README.md for the equivalent local commands.

FROM node:24-slim AS frontend
WORKDIR /app/webapp/frontend
COPY webapp/frontend/package.json webapp/frontend/pnpm-lock.yaml webapp/frontend/pnpm-workspace.yaml ./
RUN corepack enable && corepack pnpm install --frozen-lockfile
COPY webapp/frontend/ ./
RUN node node_modules/vite/bin/vite.js build

FROM python:3.12-slim
WORKDIR /app
COPY webapp/backend/requirements.txt webapp/backend/requirements.txt
RUN pip install --no-cache-dir -r webapp/backend/requirements.txt
COPY webapp/backend/ webapp/backend/
COPY feet/foot_layout.py feet/foot_layout.py
COPY --from=frontend /app/webapp/frontend/dist webapp/frontend/dist

# Render (and most PaaS) inject $PORT at runtime; default 10000 for local `docker run`.
ENV PORT=10000
EXPOSE 10000
CMD ["sh", "-c", "uvicorn webapp.backend.main:app --host 0.0.0.0 --port ${PORT}"]
