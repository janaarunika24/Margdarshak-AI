import datetime
from pymongo import MongoClient, ASCENDING

MONGO_URI = "mongodb+srv://baidyanathmaity53_db_user:Dnv2f71ZteaUcHH3@margdarshak.kaidqyu.mongodb.net/"
DB_NAME = "margdarshak"

client = MongoClient(
    MONGO_URI,
    tls=True,
    tlsAllowInvalidCertificates=True,
    serverSelectionTimeoutMS=30000
)

db = client[DB_NAME]

traffic = db.predicted_collection
users = db.users

users.create_index("username", unique=True)

traffic.create_index(
    [
        ("city", ASCENDING),
        ("segment_id", ASCENDING),
        ("timestamp", ASCENDING)
    ],
    unique=True
)

def round_time(ts, interval_min):
    discard = datetime.timedelta(
        minutes=ts.minute % interval_min,
        seconds=ts.second,
        microseconds=ts.microsecond
    )
    return ts - discard

def normalize_segment(city, segment_id):
    return f"{city.lower()}::{segment_id}"

def get_user(username):
    return users.find_one({"username": username})

def store_traffic_point(segment_id, value, interval_min, city):
    now = datetime.datetime.utcnow()
    ts = round_time(now, interval_min)

    traffic.update_one(
        {
            "city": city.lower(),
            "segment_id": segment_id,
            "timestamp": ts
        },
        {
            "$set": {
                "interval_min": interval_min,
                "vehicle_count": float(value)
            }
        },
        upsert=True
    )

def get_history(segment_id, city, interval_min, limit):
    cur = traffic.find(
        {
            "city": city.lower(),
            "segment_id": segment_id,
            "interval_min": interval_min
        },
        {"_id": 0, "vehicle_count": 1}
    ).sort("timestamp", -1).limit(limit)

    return [d["vehicle_count"] for d in reversed(list(cur))]
