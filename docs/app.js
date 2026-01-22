const spotSelect = document.querySelector("#spot");
const statusEl = document.querySelector("#status");
const windCard = document.querySelector("#wind-card .card-body");
const weatherCard = document.querySelector("#weather-card .card-body");
const marineCard = document.querySelector("#marine-card .card-body");
const tideCard = document.querySelector("#tide-card .card-body");
const hourlyGrid = document.querySelector("#hourly-grid");
const sourcesGrid = document.querySelector("#sources-grid");
const mapEl = document.querySelector("#map");
let map;
let markers = [];

const cardinal = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW"
];

function degToCardinal(deg) {
  if (typeof deg !== "number") return "-";
  return cardinal[Math.round(deg / 22.5) % 16];
}

function formatValue(value, suffix) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value}${suffix}`;
}

function setCardContent(el, rows) {
  el.innerHTML = rows.map((row) => `<p><span>${row.label}</span>${row.value}</p>`).join("");
}

function formatTimeLabel(isoTime) {
  if (!isoTime) return "-";
  const date = new Date(isoTime);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const apiBase = (window.KNOT_API_BASE || "").replace(/\/$/, "");

function apiUrl(path) {
  if (!apiBase) return path;
  return `${apiBase}${path}`;
}

async function loadSpots() {
  const res = await fetch(apiUrl("/api/spots"));
  const data = await res.json();
  spotSelect.innerHTML = data.spots
    .map((spot) => `<option value="${spot.id}">${spot.name}</option>`)
    .join("");

  if (data.spots.length) {
    initMap(data.spots);
    spotSelect.value = data.spots[0].id;
    await loadConditions();
  } else {
    statusEl.innerHTML = "<h2>Add a spot to data/spots.json to get started.</h2>";
  }
}

async function loadConditions() {
  const spotId = spotSelect.value;
  statusEl.classList.add("loading");
  statusEl.innerHTML = "<h2>Loading conditions...</h2><p>Checking the latest data.</p>";

  const res = await fetch(apiUrl(`/api/conditions?spot=${encodeURIComponent(spotId)}`));
  const data = await res.json();

  statusEl.classList.remove("loading");
  applyData(data);

  if (!data.sources?.open_meteo?.ok) {
    const fallback = await fetchOpenMeteoFallback(data.location.lat, data.location.lon);
    if (fallback) {
      data.current = fallback.current;
      data.hourly = fallback.hourly;
      data.sailability = getSailabilityClient(data.current);
      data.sources = data.sources || {};
      data.sources.open_meteo = { ok: true, url: fallback.url, note: "client fallback" };
      applyData(data);
    }
  }
}

function renderHourly(hourly) {
  hourlyGrid.innerHTML = "";
  if (!hourly?.time) {
    hourlyGrid.innerHTML = "<p>No hourly forecast available.</p>";
    return;
  }

  const hours = hourly.time.slice(0, 12).map((time, index) => ({
    time,
    wind: hourly.windspeed_10m?.[index],
    gust: hourly.windgusts_10m?.[index],
    temp: hourly.temperature_2m?.[index]
  }));

  hourlyGrid.innerHTML = hours
    .map(
      (hour) => `
        <div class="hour">
          <p>${formatTimeLabel(hour.time)}</p>
          <strong>${formatValue(hour.wind, " kt")}</strong>
          <span>G ${formatValue(hour.gust, " kt")}</span>
          <span>${formatValue(hour.temp, "°F")}</span>
        </div>
      `
    )
    .join("");
}

function applyData(data) {
  const sail = data.sailability ?? { status: "unknown", reason: "-" };
  statusEl.innerHTML = `
    <div>
      <p class="status-pill ${sail.status}">${sail.status}</p>
      <h2>${sail.reason}</h2>
      <p>Updated ${formatTimeLabel(data.updated_at)} for ${data.location.name ?? ""}</p>
    </div>
  `;

  const current = data.current ?? {};
  setCardContent(windCard, [
    { label: "Speed", value: formatValue(current.wind_speed_knots, " kt") },
    { label: "Gust", value: formatValue(current.wind_gust_knots, " kt") },
    { label: "Direction", value: `${formatValue(current.wind_direction_deg, "°")} ${degToCardinal(current.wind_direction_deg)}` }
  ]);

  setCardContent(weatherCard, [
    { label: "Temp", value: formatValue(current.temperature_f, "°F") },
    { label: "Weather code", value: formatValue(current.weather_code, "") },
    { label: "Time", value: formatTimeLabel(current.time) }
  ]);

  if (data.marine?.time) {
    setCardContent(marineCard, [
      { label: "Wave height", value: formatValue(data.marine.wave_height?.[0], " m") },
      { label: "Wave period", value: formatValue(data.marine.wave_period?.[0], " s") },
      { label: "Wave direction", value: `${formatValue(data.marine.wave_direction?.[0], "°")} ${degToCardinal(data.marine.wave_direction?.[0])}` }
    ]);
  } else {
    marineCard.innerHTML = "<p>No marine model data for this spot.</p>";
  }

  if (Array.isArray(data.tides)) {
    const next = data.tides.slice(0, 3).map((tide) => ({
      label: `${tide.type} ${formatTimeLabel(tide.t)}`,
      value: `${tide.v} ft`
    }));
    setCardContent(tideCard, next);
  } else {
    tideCard.innerHTML = "<p>Add a NOAA tide station for this spot.</p>";
  }

  renderHourly(data.hourly);
  renderSources(data.sources);
}

async function fetchOpenMeteoFallback(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}` +
    `&longitude=${lon}` +
    "&hourly=temperature_2m,windspeed_10m,winddirection_10m,windgusts_10m,weathercode" +
    "&current_weather=true" +
    "&windspeed_unit=kn" +
    "&temperature_unit=fahrenheit" +
    "&timezone=auto";
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const forecast = await res.json();
    const currentWeather = forecast.current_weather || {};
    return {
      url,
      current: {
        time: currentWeather.time,
        temperature_f: currentWeather.temperature,
        wind_speed_knots: currentWeather.windspeed,
        wind_direction_deg: currentWeather.winddirection,
        wind_gust_knots: currentWeather.windgusts ?? null,
        weather_code: currentWeather.weathercode
      },
      hourly: forecast.hourly ?? null
    };
  } catch (err) {
    return null;
  }
}

function renderSources(sources) {
  if (!sourcesGrid) return;
  if (!sources || Object.keys(sources).length === 0) {
    sourcesGrid.innerHTML = "<p>No source status available.</p>";
    return;
  }
  sourcesGrid.innerHTML = Object.entries(sources)
    .map(([key, info]) => {
      const ok = info?.ok;
      return `
        <div class="source-pill ${ok ? "ok" : "offline"}">
          <span>${key.replace(/_/g, " ")}</span>
          <strong>${ok ? "live" : "offline"}</strong>
        </div>
      `;
    })
    .join("");
}

function getSailabilityClient(current) {
  if (!current || typeof current.wind_speed_knots !== "number") {
    return { status: "unknown", reason: "No wind data available." };
  }
  const speed = current.wind_speed_knots;
  const gust = current.wind_gust_knots ?? speed;
  if (speed >= 12 && speed <= 25 && gust <= 30) {
    return { status: "go", reason: "Wind in the 12-25 kt range with manageable gusts." };
  }
  if ((speed >= 8 && speed < 12) || (speed > 25 && speed <= 30)) {
    return { status: "marginal", reason: "Wind is close but not ideal." };
  }
  return { status: "no-go", reason: "Wind outside the usual sailing range." };
}

function initMap(spots) {
  if (!mapEl || typeof L === "undefined") return;
  map = L.map(mapEl, { scrollWheelZoom: false }).setView([37.79, -122.3], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  markers = spots.map((spot) => {
    const marker = L.marker([spot.lat, spot.lon]).addTo(map);
    marker.bindPopup(`<strong>${spot.name}</strong><br/>Click to load`);
    marker.on("click", () => {
      spotSelect.value = spot.id;
      loadConditions().catch(() => {
        statusEl.innerHTML = "<h2>Unable to load data right now.</h2>";
      });
    });
    return marker;
  });
}

spotSelect.addEventListener("change", () => {
  loadConditions().catch(() => {
    statusEl.innerHTML = "<h2>Unable to load data right now.</h2>";
  });
});

loadSpots().catch(() => {
  statusEl.innerHTML = "<h2>Unable to load spots.</h2>";
});
