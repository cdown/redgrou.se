# Data import format

redgrou.se accepts CSV files exported from [Birda](https://www.birda.org/). You
can export your sightings [on this page](https://app.birda.org/exports).

## Required columns

Your CSV must include these columns (case-sensitive):

- `sightingId` - Unique identifier for each sighting (UUID format)
- `date` - ISO 8601 date/time string (e.g., `2020-02-14T09:34:18.584Z`)
- `longitude` - Decimal degrees (WGS84)
- `latitude` - Decimal degrees (WGS84)
- `commonName` - Common name of the species

## Optional columns

These columns are recognised but not required:

- `scientificName` - Scientific name of the species
- `count` - Number of individuals observed (defaults to 1 if missing)

Any other columns in your CSV are ignored. The parser is case-sensitive, so
`commonName` is required, but `CommonName` or `COMMONNAME` will not be
recognised.

## Format requirements

- **Encoding**: UTF-8 or Windows-1252 (Excel CSV files are automatically
  handled)
- **Headers**: First row must contain column names
- **File size**: Maximum 200 MB
- **Row limit**: Maximum 250,000 rows per upload
- **Column limit**: Maximum 256 columns per CSV
- **Row size**: Maximum 8 KiB per row

Rows with missing required fields are silently skipped. Invalid coordinates
(latitude/longitude that cannot be parsed as numbers) are also skipped.

## Geocoding

Country and region codes are automatically derived from coordinates using
OpenStreetMap boundary data. If a coordinate cannot be geocoded, the country
code is set to `XX`.

## Tick computation

After upload, the system automatically computes:

- **Lifers**: First sighting of each species (across all uploads)
- **Year ticks**: First sighting of each species per calendar year
- **Country ticks**: First sighting of each species per country

These flags are used for filtering and to boost visibility of significant
sightings on the map.

## Adding support for other formats

If you'd like to add support for exports from other services, please open a PR
or an issue with an example export. The parser is designed to be extensible.
