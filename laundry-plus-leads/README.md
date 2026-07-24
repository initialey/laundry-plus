# laundry-plus-leads

Taguig City / BGC (Bonifacio Global City) corporate lead collection tool
for Laundry+ B2B sales outreach (hotels, restaurants, cafes, salons,
spas, clinics, etc.).

This is a standalone tool, independent of the Saitama project and the
main Laundry+ ordering app.

## What it does

Queries the Google Places API (New) Nearby Search endpoint around a BGC
center point, filters out low-rated venues, businesses with no listed
phone number, and third-party booking/review portals (Agoda, Booking.com,
TripAdvisor, etc.), then writes a deduplicated, scored CSV of leads.

## Setup

```bash
cd laundry-plus-leads
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

export GOOGLE_PLACES_API_KEY="your-api-key-here"
```

The API key is only ever read from the `GOOGLE_PLACES_API_KEY`
environment variable — it is never hard-coded in this repo.

## Run

```bash
python collect_leads.py
```

Output is written to `output/taguig_bgc_leads_YYYYMMDD.csv`, sorted by
lead score (descending). A summary (total leads, per-category counts,
high-priority lead count, and the output path) is printed to stdout
after the run.

## Search configuration

Edit `config.py` to change:

- `SEARCH_CENTER` / `SEARCH_RADIUS_METERS` — search area (defaults to a
  3000m radius around BGC, 14.5547, 121.0509)
- `CATEGORIES` — Places API included types searched (one Nearby Search
  request per category): `restaurant`, `cafe`, `beauty_salon`, `spa`.
  Hotel/lodging/motel are intentionally excluded — this tool targets
  small/mid-size businesses, and hotel results are dominated by large
  chains.
- `MIN_RATING` — minimum rating filter (default 3.8)
- `MIN_REVIEW_COUNT` / `MAX_REVIEW_COUNT` — review count band (default
  500–4000). Below the minimum, review volume is too low to gauge real
  throughput; above the maximum, the venue is very likely a large chain
  outlet.
- `PORTAL_EXCLUDE_KEYWORDS` — name/website substrings that mark a result
  as a third-party portal or major chain to exclude (booking sites like
  Agoda/TripAdvisor, plus chains like McDonald's, Starbucks, Jollibee,
  Shangri-La, Marriott, etc.)
- scoring weights/thresholds (see "Lead scoring" below)

Note: Nearby Search (New) returns at most 20 results per category per
call, so each category is capped at 20 raw results before filtering.

## CSV columns

| Column | Description |
|---|---|
| name | Business name |
| category | Places API type used to find this lead (hotel/restaurant/cafe/etc.) |
| address | Formatted address |
| phone | National phone number |
| rating | Google rating |
| review_count | Number of ratings |
| website | Business website, if listed |
| google_maps_url | Google Maps URL |
| place_id | Google Place ID (used for de-duplication) |
| lead_score | Computed lead score, 1-10 (see below) |

## Lead scoring (1-10)

Points are summed and clamped to the 1-10 range:

- Rating >= 4.0: +3
- Review count >= 50: +2
- Has a phone number: +2
- Has a website: +1

Leads with a score of 7 or higher are counted as "high priority" in the
run summary.

## API usage / compliance notes

- Requests use the Places API (New) `places:searchNearby` endpoint with
  an explicit field mask to limit billed data per request.
- This tool is intended for legitimate B2B outreach only. Review
  Google's Places API Terms of Service regarding data caching/storage
  limits before persisting results beyond ad-hoc CSV exports.
