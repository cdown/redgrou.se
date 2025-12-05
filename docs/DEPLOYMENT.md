# Production deployment

This guide covers deploying redgrou.se to a production environment.

## Prerequisites

- Rust 1.85+ (for building the backend)
- Node.js 20+ (for building the frontend)
- SQLite 3.35+ (for the database)
- A reverse proxy (nginx, Caddy, or similar) if exposing to the internet

## System requirements

redgrou.se is designed to run on resource-constrained servers. The current
production deployment runs on:

- 1 CPU core
- 1 GB RAM
- SQLite database (no separate database server required)

For larger datasets or higher traffic, you may need additional resources. The
database file size will grow with the number of sightings, but SQLite handles
datasets up to several gigabytes efficiently.

## Build process

The `./rgrse prod` script handles the production build:

1. Compiles the Rust backend in release mode with native CPU optimisations
2. Builds the Next.js frontend for production
3. Starts both services

For a manual build:

```bash
# Backend
cd backend
RUSTFLAGS="-C target-cpu=native" cargo build --release

# Frontend
cd frontend
npm ci
NEXT_PUBLIC_API_URL="https://your-domain.com" npm run build
```

## Environment variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite:redgrouse.db` | SQLite database connection string |
| `PORT` or `REDGROUSE_BACKEND_PORT` | `3001` | Backend server port |
| `RUST_LOG` | `info` | Logging level (debug, info, warn, error) |

### Frontend

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Backend API URL (must be set for production) |
| `PORT` or `REDGROUSE_FRONTEND_PORT` | `3000` | Frontend server port |
| `NEXT_RATE_LIMIT_PER_MIN` | `1000` | Frontend middleware rate limit |

Build-time variables (automatically set during build):

- `NEXT_PUBLIC_BUILD_VERSION` - Git commit hash
- `NEXT_PUBLIC_BUILD_DATE` - Build timestamp
- `NEXT_PUBLIC_NEXTJS_VERSION` - Next.js version
- `NEXT_PUBLIC_NODE_VERSION` - Node.js version

## Database location

The SQLite database is stored at `$REDGROUSE_DATA_DIR/redgrouse.db` (default:
`./data/redgrouse.db`). Set `REDGROUSE_DATA_DIR` to control where the database
is stored.

**Important**: Ensure the data directory is writable by the process and
regularly backed up. SQLite databases can be backed up by simply copying the
`.db` file while the server is running (WAL mode handles this safely).

## Reverse proxy setup

If exposing redgrou.se to the internet, use a reverse proxy (nginx, Caddy,
etc.) in front of the application. The backend automatically trusts CloudFront
and Cloudflare proxy headers for accurate IP-based rate limiting.

### nginx example

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy example

```caddy
your-domain.com {
    reverse_proxy /api/* localhost:3001
    reverse_proxy localhost:3000
}
```

## Security considerations

- Edit tokens are stored as SHA256 hashes in the database
- Rate limiting prevents abuse without penalising legitimate users
- Maximum upload size (200 MB) and row limits (250,000) prevent DoS attacks
- Filter nesting depth is limited to prevent expensive queries
- No authentication is required for viewing data (by design)
