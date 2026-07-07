# @contextio/web

Web interface for ContextIO-Next proxy monitoring and inspection.

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Run linting
pnpm lint
```

## Features

- **Dashboard**: Overview of proxy status and quick actions
- **Sessions**: View and inspect captured API requests/responses
- **Settings**: Configure logging and redaction options

## API Connection

The web interface connects to the ContextIO-Next proxy API at `http://localhost:4040` by default. Configure via `NEXT_PUBLIC_API_URL` environment variable.

## Usage with Docker

```bash
docker run -p 4040:4040 -p 3000:3000 \
  -e CONTEXT_PROXY_PORT=4040 \
  ghcr.io/larsderidder/contextio-next:latest
```

Then access the web interface at `http://localhost:3000`.