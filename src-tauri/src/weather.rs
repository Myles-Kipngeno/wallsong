//! The Dock's weather tile, from Open-Meteo (free, no API key). Fetched here
//! rather than in the page, so there's no cross-site (CORS) problem.

use std::sync::OnceLock;
use serde::Serialize;
use serde_json::Value;

const FORECAST: &str = "https://api.open-meteo.com/v1/forecast";
const GEOCODING: &str = "https://geocoding-api.open-meteo.com/v1/search";
const USER_AGENT: &str = "Wallsong/0.5 (personal desktop music skin)";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Now and today, in °C (the Dock converts to °F if you ask for it).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub temperature: f64,
    pub high: f64,
    pub low: f64,
    pub code: i64,
    pub is_day: bool,
    /// "sun", "moon", "cloud", "rain", "storm", "snow" or "fog".
    pub glyph: &'static str,
}

/// A city from the search box.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    /// "Nairobi County, Kenya": enough to tell same-named places apart.
    pub region: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// The tile's picture for a WMO weather code (Open-Meteo's `weather_code`).
pub fn glyph(code: i64, is_day: bool) -> &'static str {
    match code {
        0 if is_day => "sun",
        0 => "moon",
        1..=3 => "cloud",
        45 | 48 => "fog",
        51..=67 | 80..=82 => "rain",
        71..=77 | 85 | 86 => "snow",
        95..=99 => "storm",
        _ => "cloud",
    }
}

/// Reads Open-Meteo's forecast answer (current + daily).
pub fn parse_forecast(v: &Value) -> Result<Weather, String> {
    let current = &v["current"];
    let temperature = current["temperature_2m"].as_f64().ok_or("the forecast had no current temperature")?;
    let code = current["weather_code"].as_i64().unwrap_or(0);
    // is_day comes as 1/0.
    let is_day = current["is_day"].as_i64().map(|d| d != 0).or_else(|| current["is_day"].as_bool()).unwrap_or(true);
    let first = |key: &str| v["daily"][key].get(0).and_then(Value::as_f64);
    Ok(Weather {
        temperature,
        high: first("temperature_2m_max").unwrap_or(temperature),
        low: first("temperature_2m_min").unwrap_or(temperature),
        code,
        is_day,
        glyph: glyph(code, is_day),
    })
}

/// Reads Open-Meteo's geocoding answer.
pub fn parse_places(v: &Value) -> Vec<Place> {
    let Some(results) = v["results"].as_array() else { return vec![] };
    results
        .iter()
        .filter_map(|r| {
            let region = [r["admin1"].as_str(), r["country"].as_str()].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ");
            Some(Place { name: r["name"].as_str()?.to_string(), region, latitude: r["latitude"].as_f64()?, longitude: r["longitude"].as_f64()? })
        })
        .collect()
}

fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = CLIENT.set(c);
    CLIENT.get().ok_or_else(|| "weather client init failed".into())
}

async fn get_json(url: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let resp = client()?.get(url).query(query).send().await.map_err(|e| format!("couldn't reach Open-Meteo: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Open-Meteo answered {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| format!("Open-Meteo sent something unexpected: {e}"))
}

pub async fn forecast(lat: f64, lon: f64) -> Result<Weather, String> {
    let v = get_json(
        FORECAST,
        &[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,weather_code,is_day".into()),
            ("daily", "temperature_2m_max,temperature_2m_min".into()),
            ("timezone", "auto".into()),
        ],
    )
    .await?;
    parse_forecast(&v)
}

pub async fn find(city: &str) -> Result<Vec<Place>, String> {
    let city = city.trim();
    if city.len() < 2 {
        return Ok(vec![]);
    }
    let v = get_json(GEOCODING, &[("name", city.to_string()), ("count", "5".into())]).await?;
    Ok(parse_places(&v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wmo_codes_to_glyphs() {
        assert_eq!(glyph(0, true), "sun");
        assert_eq!(glyph(0, false), "moon");
        for code in [1, 2, 3] {
            assert_eq!(glyph(code, true), "cloud");
        }
        assert_eq!(glyph(45, true), "fog");
        assert_eq!(glyph(48, false), "fog");
        for code in [51, 55, 61, 63, 65, 66, 67, 80, 81, 82] {
            assert_eq!(glyph(code, true), "rain", "code {code}");
        }
        for code in [71, 73, 75, 77, 85, 86] {
            assert_eq!(glyph(code, true), "snow", "code {code}");
        }
        for code in [95, 96, 99] {
            assert_eq!(glyph(code, false), "storm", "code {code}");
        }
        assert_eq!(glyph(1, false), "cloud"); // only a clear sky turns into the moon
    }

    #[test]
    fn parses_an_open_meteo_forecast() {
        let sample = json!({
            "latitude": -1.28, "longitude": 36.82, "timezone": "Africa/Nairobi",
            "current_units": {"temperature_2m": "°C"},
            "current": {"time": "2026-11-24T15:45", "interval": 900, "temperature_2m": 24.3, "weather_code": 80, "is_day": 1},
            "daily": {"time": ["2026-11-24"], "temperature_2m_max": [26.1], "temperature_2m_min": [14.8]}
        });
        let w = parse_forecast(&sample).unwrap();
        assert_eq!(w, Weather { temperature: 24.3, high: 26.1, low: 14.8, code: 80, is_day: true, glyph: "rain" });

        let night = json!({"current": {"temperature_2m": 12.0, "weather_code": 0, "is_day": 0}, "daily": {}});
        let w = parse_forecast(&night).unwrap();
        assert_eq!((w.glyph, w.high, w.low), ("moon", 12.0, 12.0));

        assert!(parse_forecast(&json!({"error": true, "reason": "bad latitude"})).is_err());
    }

    #[test]
    fn parses_geocoding_results() {
        let sample = json!({"results": [
            {"id": 184745, "name": "Nairobi", "latitude": -1.28333, "longitude": 36.81667, "country": "Kenya", "admin1": "Nairobi County"},
            {"id": 1, "name": "Nowhere", "country": "Kenya"}
        ]});
        assert_eq!(
            parse_places(&sample),
            vec![Place { name: "Nairobi".into(), region: "Nairobi County, Kenya".into(), latitude: -1.28333, longitude: 36.81667 }]
        );
        assert!(parse_places(&json!({"generationtime_ms": 0.5})).is_empty());
    }
}
