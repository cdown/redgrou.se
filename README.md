# redgrou.se

https://github.com/user-attachments/assets/a6956e5b-c8ac-4214-9dd8-7d24c9554e32

A bird sighting analytics platform. Upload your sightings, explore them all on
an interactive map, and filter by species, location, date, significance, etc.

## Quick start

### Prerequisites

- Rust 1.85+
- Node.js 20+
- npm

### Running a development build

```bash
./rgrse dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For more information about development setup, debugging, and contribution, read
[docs/HACKING.md](docs/HACKING.md). You may also want to read about how
redgrou.se is designed at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Running a production build

```bash
./rgrse prod
```

This compiles the Rust backend in release mode and builds the Next.js frontend
for production.

## Data import formats

redgrou.se accepts CSV exports from [Birda](https://www.birda.org/). You can
export them [on this page](https://app.birda.org/exports).

Adding support for exports from other services is very welcome, please feel
free to open a PR, or an issue with an example export.
