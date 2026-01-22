const spotSelect = document.querySelector("#spot");
const statusEl = document.querySelector("#status");
const windCard = document.querySelector("#wind-card .card-body");
const weatherCard = document.querySelector("#weather-card .card-body");
const marineCard = document.querySelector("#marine-card .card-body");
const tideCard = document.querySelector("#tide-card .card-body");
const hourlyGrid = document.querySelector("#hourly-grid");
const sourcesGrid = document.querySelector("#sources-grid");
const mapEl = document.querySelector("#map");
const windUnitLabel = document.querySelector("#wind-unit-label");
const settingsToggle = document.querySelector("#settings-toggle");
const settingsPanel = document.querySelector("#settings-panel");
const windUnitSelect = document.querySelector("#wind-unit");
const tempUnitSelect = document.querySelector("#temp-unit");
const waveUnitSelect = document.querySelector("#wave-unit");
let map;
let markers = {};
let lastConditions = null;
let lastMap = null;

const defaultSettings = {
  windUnit: "kt",
  tempUnit: "f",
  waveUnit: "m"
};
let settings = loadSettings();

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

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("knot_settings"));
    return { ...defaultSettings, ...stored };
  } catch (err) {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  localStorage.setItem("knot_settings", JSON.stringify(settings));
}

function knotsToMph(knots) {
  return knots * 1.15078;
}

function metersToFeet(meters) {
  return meters * 3.28084;
}

function formatWind(valueKnots) {
  if (valueKnots === null || valueKnots === undefined || Number.isNaN(valueKnots)) return "-";
  if (settings.windUnit === "mph") {
    return `${Math.round(knotsToMph(valueKnots))} mph`;
  }
  return `${Math.round(valueKnots)} kt`;
}

function formatTemp(valueF) {
  if (valueF === null || valueF === undefined || Number.isNaN(valueF)) return "-";
  if (settings.tempUnit === "c") {
    return `${Math.round(((valueF - 32) * 5) / 9)}°C`;
  }
  return `${Math.round(valueF)}°F`;
}

function formatWave(valueMeters) {
  if (valueMeters === null || valueMeters === undefined || Number.isNaN(valueMeters)) return "-";
  if (settings.waveUnit === "ft") {
    return `${metersToFeet(valueMeters).toFixed(1)} ft`;
  }
  return `${valueMeters.toFixed(1)} m`;
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
    loadMapWind().catch(() => {
      // ignore map wind errors
    });
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
  lastConditions = data;
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
          <strong>${formatWind(hour.wind)}</strong>
          <span>G ${formatWind(hour.gust)}</span>
          <span>${formatTemp(hour.temp)}</span>
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
  const gustLabel = current.wind_gust_source === "hourly" ? "Gust (hourly)" : "Gust";
  setCardContent(windCard, [
    { label: "Speed", value: formatWind(current.wind_speed_knots) },
    { label: gustLabel, value: formatWind(current.wind_gust_knots) },
    { label: "Direction", value: `${formatValue(current.wind_direction_deg, "°")} ${degToCardinal(current.wind_direction_deg)}` }
  ]);

  setCardContent(weatherCard, [
    { label: "Temp", value: formatTemp(current.temperature_f) },
    { label: "Weather code", value: formatValue(current.weather_code, "") },
    { label: "Time", value: formatTimeLabel(current.time) }
  ]);

  if (data.marine?.time) {
    setCardContent(marineCard, [
      { label: "Wave height", value: formatWave(data.marine.wave_height?.[0]) },
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
    const hourlyGusts = forecast.hourly?.windgusts_10m;
    const fallbackGust =
      Array.isArray(hourlyGusts) && hourlyGusts.length ? hourlyGusts[0] : null;
    return {
      url,
      current: {
        time: currentWeather.time,
        temperature_f: currentWeather.temperature,
        wind_speed_knots: currentWeather.windspeed,
        wind_direction_deg: currentWeather.winddirection,
        wind_gust_knots: currentWeather.windgusts ?? fallbackGust,
        wind_gust_source: currentWeather.windgusts != null ? "current" : "hourly",
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

  markers = {};
  spots.forEach((spot) => {
    const marker = L.marker([spot.lat, spot.lon], {
      icon: buildWindIcon(null, null, null)
    }).addTo(map);
    marker.bindPopup(`<strong>${spot.name}</strong><br/>Click to load`);
    marker.on("click", () => {
      spotSelect.value = spot.id;
      loadConditions().catch(() => {
        statusEl.innerHTML = "<h2>Unable to load data right now.</h2>";
      });
    });
    markers[spot.id] = marker;
  });
}

async function loadMapWind() {
  const res = await fetch(apiUrl("/api/map"));
  const data = await res.json();
  lastMap = data;
  data.spots.forEach((spot) => {
    const marker = markers[spot.id];
    if (!marker) return;
    const wind = spot.wind;
    marker.setIcon(buildWindIcon(wind?.mean_speed_knots ?? null, wind?.mean_direction_deg ?? null, wind?.std_dev_knots ?? null));
    const stdText =
      wind?.std_dev_knots != null
        ? settings.windUnit === "mph"
          ? `±${Math.round(knotsToMph(wind.std_dev_knots))} mph`
          : `±${wind.std_dev_knots} kt`
        : "-";
    const speedLabel = wind?.mean_speed_knots != null ? formatWind(wind.mean_speed_knots) : "-";
    const srcCount = wind?.sources ? wind.sources.length : 0;
    marker.setPopupContent(
      `<strong>${spot.name}</strong><br/>Wind: ${speedLabel}<br/>Dir: ${wind?.mean_direction_deg ?? "-"}°<br/>Std dev: ${stdText}<br/>Sources: ${srcCount}`
    );
  });
}

function buildWindIcon(speed, direction, stdDev) {
  const label = speed == null ? "--" : Math.round(settings.windUnit === "mph" ? knotsToMph(speed) : speed);
  const rotation = direction == null ? 0 : direction;
  const uncertainty = stdDev != null && stdDev > 2 ? "wind-uncertain" : "";
  return L.divIcon({
    className: "wind-icon",
    html: `
      <div class="wind-marker ${uncertainty}">
        <div class="wind-arrow" style="transform: rotate(${rotation}deg)"></div>
        <div class="wind-speed">${label}</div>
      </div>
    `,
    iconSize: [50, 50],
    iconAnchor: [25, 25]
  });
}

setInterval(() => {
  if (map) {
    loadMapWind().catch(() => {
      // ignore map refresh errors
    });
  }
}, 10 * 60 * 1000);

function applySettingsToUI() {
  windUnitSelect.value = settings.windUnit;
  tempUnitSelect.value = settings.tempUnit;
  waveUnitSelect.value = settings.waveUnit;
  if (windUnitLabel) {
    windUnitLabel.textContent = `Wind in ${settings.windUnit === "mph" ? "mph" : "kt"}`;
  }
}

function refreshFromSettings() {
  if (lastConditions) {
    applyData(lastConditions);
  }
  if (lastMap) {
    lastMap.spots.forEach((spot) => {
      const marker = markers[spot.id];
      if (!marker) return;
      const wind = spot.wind;
      marker.setIcon(buildWindIcon(wind?.mean_speed_knots ?? null, wind?.mean_direction_deg ?? null, wind?.std_dev_knots ?? null));
    });
  }
}

settingsToggle.addEventListener("click", () => {
  const isOpen = settingsPanel.classList.toggle("open");
  settingsPanel.setAttribute("aria-hidden", String(!isOpen));
});

[windUnitSelect, tempUnitSelect, waveUnitSelect].forEach((select) => {
  select.addEventListener("change", () => {
    settings = {
      windUnit: windUnitSelect.value,
      tempUnit: tempUnitSelect.value,
      waveUnit: waveUnitSelect.value
    };
    saveSettings();
    applySettingsToUI();
    refreshFromSettings();
  });
});

applySettingsToUI();

spotSelect.addEventListener("change", () => {
  loadConditions().catch(() => {
    statusEl.innerHTML = "<h2>Unable to load data right now.</h2>";
  });
});

loadSpots().catch(() => {
  statusEl.innerHTML = "<h2>Unable to load spots.</h2>";
});
