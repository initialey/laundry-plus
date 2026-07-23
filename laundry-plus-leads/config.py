"""Configuration for the Taguig/BGC corporate lead collection script.

API key is read from the GOOGLE_PLACES_API_KEY environment variable.
Never hard-code the key here.
"""

import os

GOOGLE_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")

PLACES_API_BASE_URL = "https://places.googleapis.com/v1/places:searchNearby"

# BGC (Bonifacio Global City) center point, covering Taguig City / BGC.
SEARCH_CENTER = {
    "lat": 14.5547,
    "lng": 121.0509,
}
SEARCH_RADIUS_METERS = 3000

# Places API (New) included types. Each category is queried separately.
CATEGORIES = [
    "hotel",
    "lodging",
    "motel",
    "restaurant",
    "cafe",
    "food",
    "beauty_salon",
    "spa",
    "clinic",
]

LANGUAGE_CODE = "en"

# Max results per Nearby Search request (API hard limit is 20).
MAX_RESULTS_PER_CATEGORY = 20

# --- Filters -----------------------------------------------------------

MIN_RATING = 3.5

# Names/websites containing these (case-insensitive) are excluded as
# third-party booking/review portals rather than the business itself.
PORTAL_EXCLUDE_KEYWORDS = [
    "agoda",
    "booking.com",
    "booking",
    "tripadvisor",
    "expedia",
    "trivago",
    "hotels.com",
    "airbnb",
    "foursquare",
    "yelp",
    "zomato",
    "opentable",
    "klook",
    "traveloka",
]

# --- Lead scoring (1-10) ------------------------------------------------

SCORE_RATING_HIGH_THRESHOLD = 4.0
SCORE_RATING_HIGH_POINTS = 3

SCORE_REVIEW_COUNT_THRESHOLD = 50
SCORE_REVIEW_COUNT_POINTS = 2

SCORE_PHONE_POINTS = 2

SCORE_WEBSITE_POINTS = 1

SCORE_LODGING_CATEGORIES = {"hotel", "lodging"}
SCORE_LODGING_POINTS = 2

HIGH_PRIORITY_SCORE_THRESHOLD = 7

OUTPUT_DIR = "output"
OUTPUT_FILENAME_PREFIX = "taguig_bgc_leads_"
