import asyncio
import json
import math
import re
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
SPOTS_PATH = ROOT / "data" / "spots.json"
CACHE_TTL_SECONDS = 10 * 60
MAP_CACHE_TTL_SECONDS = 10 * 60

app = FastAPI(title="knot")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

cache: dict[str, dict[str, Any]] = {}
map_cache: dict[str, dict[str, Any]] = {}


def load_spots() -> list[dict[str, Any]]:
    if not SPOTS_PATH.exists():
        return []
    try:
        return json.loads(SPOTS_PATH.read_text())
    except json.JSONDecodeError:
        return []


spots = load_spots()


def set_cache(key: str, value: dict[str, Any]) -> None:
    cache[key] = {"value": value, "expires_at": time.time() + CACHE_TTL_SECONDS}


def get_cache(key: str) -> Optional[dict[str, Any]]:
    entry = cache.get(key)
    if not entry:
        return None
    if time.time() > entry["expires_at"]:
        cache.pop(key, None)
        return None
    return entry["value"]


def set_map_cache(key: str, value: dict[str, Any]) -> None:
    map_cache[key] = {"value": value, "expires_at": time.time() + MAP_CACHE_TTL_SECONDS}


def get_map_cache(key: str) -> Optional[dict[str, Any]]:
    entry = map_cache.get(key)
    if not entry:
        return None
    if time.time() > entry["expires_at"]:
        map_cache.pop(key, None)
        return None
    return entry["value"]


def clamp_number(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def get_spot_by_id(spot_id: str) -> Optional[dict[str, Any]]:
    return next((spot for spot in spots if spot.get("id") == spot_id), None)


def get_sailability(current: Optional[dict[str, Any]]) -> dict[str, str]:
    if not current or not isinstance(current.get("wind_speed_knots"), (int, float)):
        return {"status": "unknown", "reason": "No wind data available."}

    speed = current["wind_speed_knots"]
    gust = current.get("wind_gust_knots", speed)

    if 12 <= speed <= 25 and gust <= 30:
        return {"status": "go", "reason": "Wind in the 12-25 kt range with manageable gusts."}
    if 8 <= speed < 12 or 25 < speed <= 30:
        return {"status": "marginal", "reason": "Wind is close but not ideal."}
    return {"status": "no-go", "reason": "Wind outside the usual sailing range."}


def slice_hourly(
    hourly: Optional[dict[str, list[Any]]], count: int = 24
) -> Optional[dict[str, list[Any]]]:
    if not hourly or not isinstance(hourly.get("time"), list):
        return None
    limited: dict[str, list[Any]] = {}
    for key, values in hourly.items():
        if isinstance(values, list):
            limited[key] = values[:count]
    return limited


async def fetch_json(url: str, timeout_seconds: float = 8.0) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()


async def fetch_json_with_headers(
    url: str, headers: dict[str, str], timeout_seconds: float = 8.0
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout_seconds, headers=headers) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()


def mph_to_knots(speed_mph: float) -> float:
    return speed_mph * 0.868976


def parse_wind_speed(speed_text: str) -> Optional[float]:
    matches = re.findall(r"\d+", speed_text)
    if not matches:
        return None
    values = [float(val) for val in matches]
    if len(values) == 1:
        return mph_to_knots(values[0])
    return mph_to_knots(sum(values) / len(values))


def cardinal_to_degrees(cardinal: str) -> Optional[int]:
    mapping = {
        "N": 0,
        "NNE": 22,
        "NE": 45,
        "ENE": 67,
        "E": 90,
        "ESE": 112,
        "SE": 135,
        "SSE": 157,
        "S": 180,
        "SSW": 202,
        "SW": 225,
        "WSW": 247,
        "W": 270,
        "WNW": 292,
        "NW": 315,
        "NNW": 337,
    }
    return mapping.get(cardinal.upper())


def aggregate_wind(samples: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    valid = [sample for sample in samples if sample.get("speed_knots") is not None]
    if not valid:
        return None

    speeds = [sample["speed_knots"] for sample in valid]
    mean_speed = sum(speeds) / len(speeds)
    variance = sum((speed - mean_speed) ** 2 for speed in speeds) / len(speeds)
    std_dev = math.sqrt(variance) if len(speeds) > 1 else 0.0

    directions = [sample.get("direction_deg") for sample in valid if sample.get("direction_deg") is not None]
    if directions:
        angles = [math.radians(deg) for deg in directions]
        sin_sum = sum(math.sin(angle) for angle in angles)
        cos_sum = sum(math.cos(angle) for angle in angles)
        avg_angle = math.degrees(math.atan2(sin_sum / len(angles), cos_sum / len(angles)))
        mean_direction = int((avg_angle + 360) % 360)
    else:
        mean_direction = None

    return {
        "mean_speed_knots": round(mean_speed, 2),
        "std_dev_knots": round(std_dev, 2),
        "mean_direction_deg": mean_direction,
        "sources": [sample.get("source") for sample in valid if sample.get("source")],
    }


async def fetch_open_meteo_wind(latitude: float, longitude: float) -> dict[str, Any]:
    forecast_url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={latitude}"
        f"&longitude={longitude}"
        "&hourly=temperature_2m,windspeed_10m,winddirection_10m,windgusts_10m,weathercode"
        "&current_weather=true"
        "&windspeed_unit=kn"
        "&temperature_unit=fahrenheit"
        "&timezone=auto"
    )
    forecast = await fetch_json(forecast_url)
    return {"data": forecast, "url": forecast_url}


async def fetch_nws_wind(latitude: float, longitude: float) -> dict[str, Any]:
    headers = {"User-Agent": "knot (contact: weisfoo.com)"}
    points_url = f"https://api.weather.gov/points/{latitude},{longitude}"
    points = await fetch_json_with_headers(points_url, headers=headers)
    hourly_url = points["properties"]["forecastHourly"]
    hourly = await fetch_json_with_headers(hourly_url, headers=headers)
    periods = hourly.get("properties", {}).get("periods", [])
    if not periods:
        raise ValueError("No hourly periods available.")
    period = periods[0]
    speed_knots = parse_wind_speed(period.get("windSpeed", ""))
    direction = period.get("windDirection", "")
    direction_deg = None
    if direction and direction.lower() != "variable":
        direction_deg = cardinal_to_degrees(direction)
    return {
        "data": {
            "time": period.get("startTime"),
            "wind_speed_knots": speed_knots,
            "wind_direction_deg": direction_deg,
        },
        "url": hourly_url,
    }


@app.get("/api/spots")
def api_spots() -> dict[str, Any]:
    return {"spots": spots}


@app.get("/api/conditions")
async def api_conditions(
    spot: Optional[str] = None,
    lat: Optional[float] = Query(default=None),
    lon: Optional[float] = Query(default=None),
) -> JSONResponse:
    spot_data = None
    latitude = lat
    longitude = lon

    if spot:
        spot_data = get_spot_by_id(spot)
        if not spot_data:
            raise HTTPException(status_code=404, detail="Unknown spot.")
        latitude = spot_data["lat"]
        longitude = spot_data["lon"]

    if latitude is None or longitude is None:
        raise HTTPException(status_code=400, detail="Provide lat/lon or a valid spot id.")

    latitude = clamp_number(latitude, -90, 90)
    longitude = clamp_number(longitude, -180, 180)

    cache_key = f"conditions:{spot_data['id'] if spot_data else 'latlon'}:{latitude}:{longitude}"
    cached = get_cache(cache_key)
    if cached:
        return JSONResponse(cached)

    response: dict[str, Any] = {
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "location": {
            "name": spot_data["name"] if spot_data else None,
            "lat": latitude,
            "lon": longitude,
        },
        "sources": {},
        "current": None,
        "hourly": None,
        "marine": None,
        "tides": None,
        "sailability": {"status": "unknown", "reason": "No wind data available."},
    }

    try:
        forecast_payload = await fetch_open_meteo_wind(latitude, longitude)
        forecast = forecast_payload["data"]
        response["sources"]["open_meteo"] = {"ok": True, "url": forecast_payload["url"]}
        current_weather = forecast.get("current_weather")
        if current_weather:
            gust = current_weather.get("windgusts")
            if gust is None:
                hourly_gusts = (forecast.get("hourly") or {}).get("windgusts_10m")
                gust = hourly_gusts[0] if isinstance(hourly_gusts, list) and hourly_gusts else None
            response["current"] = {
                "time": current_weather.get("time"),
                "temperature_f": current_weather.get("temperature"),
                "wind_speed_knots": current_weather.get("windspeed"),
                "wind_direction_deg": current_weather.get("winddirection"),
                "wind_gust_knots": gust,
                "weather_code": current_weather.get("weathercode"),
            }

        response["hourly"] = slice_hourly(forecast.get("hourly"))
    except Exception as exc:
        response["sources"]["open_meteo"] = {"ok": False, "error": str(exc)}

    marine_url = (
        "https://marine-api.open-meteo.com/v1/marine"
        f"?latitude={latitude}"
        f"&longitude={longitude}"
        "&hourly=wave_height,wave_direction,wave_period"
        "&timezone=auto"
    )

    try:
        marine = await fetch_json(marine_url)
        response["sources"]["open_meteo_marine"] = {"ok": True, "url": marine_url}
        response["marine"] = slice_hourly(marine.get("hourly"))
    except Exception as exc:
        response["sources"]["open_meteo_marine"] = {"ok": False, "error": str(exc), "url": marine_url}

    if spot_data and spot_data.get("noaa_tide_station"):
        station = spot_data["noaa_tide_station"]
        tide_url = (
            "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
            "?product=predictions"
            "&application=knot"
            "&date=today"
            "&datum=MLLW"
            f"&station={station}"
            "&time_zone=lst_ldt"
            "&interval=hilo"
            "&units=english"
            "&format=json"
        )
        try:
            tides = await fetch_json(tide_url)
            response["sources"]["noaa_tides"] = {"ok": True, "url": tide_url}
            response["tides"] = tides.get("predictions")
        except Exception as exc:
            response["sources"]["noaa_tides"] = {"ok": False, "error": str(exc), "url": tide_url}

    response["sailability"] = get_sailability(response.get("current"))
    wind_samples = []
    if response.get("current") and response["current"].get("wind_speed_knots") is not None:
        wind_samples.append(
            {
                "source": "open_meteo",
                "speed_knots": response["current"]["wind_speed_knots"],
                "direction_deg": response["current"].get("wind_direction_deg"),
            }
        )

    try:
        nws_payload = await fetch_nws_wind(latitude, longitude)
        response["sources"]["nws"] = {"ok": True, "url": nws_payload["url"]}
        nws_data = nws_payload["data"]
        wind_samples.append(
            {
                "source": "nws",
                "speed_knots": nws_data.get("wind_speed_knots"),
                "direction_deg": nws_data.get("wind_direction_deg"),
            }
        )
    except Exception as exc:
        response["sources"]["nws"] = {"ok": False, "error": str(exc)}

    response["wind_aggregate"] = aggregate_wind(wind_samples)
    set_cache(cache_key, response)
    return JSONResponse(response)


@app.get("/api/map")
async def api_map() -> JSONResponse:
    cached = get_map_cache("map")
    if cached:
        return JSONResponse(cached)

    async def build_spot(spot: dict[str, Any]) -> dict[str, Any]:
        latitude = spot["lat"]
        longitude = spot["lon"]
        wind_samples: list[dict[str, Any]] = []

        try:
            forecast_payload = await fetch_open_meteo_wind(latitude, longitude)
            forecast = forecast_payload["data"]
            current_weather = forecast.get("current_weather", {})
            wind_samples.append(
                {
                    "source": "open_meteo",
                    "speed_knots": current_weather.get("windspeed"),
                    "direction_deg": current_weather.get("winddirection"),
                }
            )
        except Exception:
            pass

        try:
            nws_payload = await fetch_nws_wind(latitude, longitude)
            nws_data = nws_payload["data"]
            wind_samples.append(
                {
                    "source": "nws",
                    "speed_knots": nws_data.get("wind_speed_knots"),
                    "direction_deg": nws_data.get("wind_direction_deg"),
                }
            )
        except Exception:
            pass

        aggregate = aggregate_wind(wind_samples)
        return {
            "id": spot["id"],
            "name": spot["name"],
            "lat": latitude,
            "lon": longitude,
            "wind": aggregate,
        }

    spots_payload = await asyncio.gather(*(build_spot(spot) for spot in spots))
    response = {"updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "spots": spots_payload}
    set_map_cache("map", response)
    return JSONResponse(response)


app.mount("/", StaticFiles(directory=ROOT / "public", html=True), name="static")
