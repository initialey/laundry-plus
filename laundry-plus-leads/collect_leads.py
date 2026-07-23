#!/usr/bin/env python3
"""Collect corporate laundry leads (hotels, restaurants, salons, etc.)
in Taguig City / BGC using the Google Places API (New).

Usage:
    export GOOGLE_PLACES_API_KEY="your-api-key"
    python collect_leads.py
"""

import csv
import datetime
import os
import sys
import time

import requests

import config

FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.nationalPhoneNumber",
        "places.internationalPhoneNumber",
        "places.rating",
        "places.userRatingCount",
        "places.websiteUri",
        "places.googleMapsUri",
        "places.types",
    ]
)

CSV_COLUMNS = [
    "name",
    "category",
    "address",
    "phone",
    "rating",
    "review_count",
    "website",
    "google_maps_url",
    "place_id",
    "lead_score",
]


def search_category(category):
    """Call Nearby Search (New) for a single included type and return the
    raw list of place dicts. Returns [] on request failure."""
    if not config.GOOGLE_PLACES_API_KEY:
        print("ERROR: GOOGLE_PLACES_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
    }
    body = {
        "includedTypes": [category],
        "maxResultCount": config.MAX_RESULTS_PER_CATEGORY,
        "languageCode": config.LANGUAGE_CODE,
        "locationRestriction": {
            "circle": {
                "center": {
                    "latitude": config.SEARCH_CENTER["lat"],
                    "longitude": config.SEARCH_CENTER["lng"],
                },
                "radius": config.SEARCH_RADIUS_METERS,
            }
        },
    }

    try:
        resp = requests.post(config.PLACES_API_BASE_URL, headers=headers, json=body, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print(f"WARNING: search failed for category '{category}': {exc}", file=sys.stderr)
        return []

    return resp.json().get("places", [])


def is_portal(name, website):
    haystack = " ".join(filter(None, [name, website])).lower()
    return any(keyword in haystack for keyword in config.PORTAL_EXCLUDE_KEYWORDS)


def compute_score(rating, review_count, phone, website, category):
    score = 0
    if rating >= config.SCORE_RATING_HIGH_THRESHOLD:
        score += config.SCORE_RATING_HIGH_POINTS
    if review_count >= config.SCORE_REVIEW_COUNT_THRESHOLD:
        score += config.SCORE_REVIEW_COUNT_POINTS
    if phone:
        score += config.SCORE_PHONE_POINTS
    if website:
        score += config.SCORE_WEBSITE_POINTS
    if category in config.SCORE_LODGING_CATEGORIES:
        score += config.SCORE_LODGING_POINTS
    return max(1, min(10, score))


def parse_place(raw, category):
    name = (raw.get("displayName") or {}).get("text", "")
    phone = raw.get("nationalPhoneNumber") or raw.get("internationalPhoneNumber") or ""
    website = raw.get("websiteUri", "")
    rating = raw.get("rating", 0.0)
    review_count = raw.get("userRatingCount", 0)
    place_id = raw.get("id", "")
    address = raw.get("formattedAddress", "")
    maps_url = raw.get("googleMapsUri", "")

    if not place_id or not phone:
        return None
    if rating < config.MIN_RATING:
        return None
    if is_portal(name, website):
        return None

    return {
        "name": name,
        "category": category,
        "address": address,
        "phone": phone,
        "rating": rating,
        "review_count": review_count,
        "website": website,
        "google_maps_url": maps_url,
        "place_id": place_id,
        "lead_score": compute_score(rating, review_count, phone, website, category),
    }


def collect_leads():
    leads_by_place_id = {}

    for category in config.CATEGORIES:
        raw_places = search_category(category)
        print(f"  {category}: {len(raw_places)} raw result(s)")
        for raw in raw_places:
            lead = parse_place(raw, category)
            if lead is None:
                continue
            if lead["place_id"] not in leads_by_place_id:
                leads_by_place_id[lead["place_id"]] = lead
        time.sleep(0.2)  # gentle pacing between requests

    return list(leads_by_place_id.values())


def write_csv(leads, output_path):
    leads_sorted = sorted(leads, key=lambda l: l["lead_score"], reverse=True)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(leads_sorted)
    return leads_sorted


def print_summary(leads_sorted, output_path):
    total = len(leads_sorted)
    by_category = {}
    for lead in leads_sorted:
        by_category[lead["category"]] = by_category.get(lead["category"], 0) + 1
    high_priority = sum(1 for l in leads_sorted if l["lead_score"] >= config.HIGH_PRIORITY_SCORE_THRESHOLD)

    print("\n=== Taguig/BGC Lead Collection Summary ===")
    print(f"Total leads: {total}")
    print("By category:")
    for category, count in sorted(by_category.items(), key=lambda kv: -kv[1]):
        print(f"  - {category}: {count}")
    print(f"High priority leads (score >= {config.HIGH_PRIORITY_SCORE_THRESHOLD}): {high_priority}")
    print(f"CSV saved to: {output_path}")


def main():
    print("Collecting leads for Taguig City / BGC...")
    leads = collect_leads()

    today = datetime.date.today().strftime("%Y%m%d")
    output_path = os.path.join(config.OUTPUT_DIR, f"{config.OUTPUT_FILENAME_PREFIX}{today}.csv")

    leads_sorted = write_csv(leads, output_path)
    print_summary(leads_sorted, output_path)


if __name__ == "__main__":
    main()
