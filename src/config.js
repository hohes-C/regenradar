// Zentrale Konfiguration. Alle Schwellen und Fenster ausschliesslich hier
// aendern, nie hart im Code. Werte sind im README dokumentiert.

// Datenquelle. Spaeter (Stufe 2) auf ein eigenes Backend umstellbar.
export const API_BASE = "https://api.brightsky.dev";

// Anfrage-Geometrie.
export const DISTANCE_M = 20000; // Ausschnitt fuer Karte und Nowcast, ergibt ~41 x 41 Pixel (~40 km)
export const PAST_MIN = 30; // Historie in der Anfrage
export const HORIZON_MIN = 120; // Vorhersagefenster
export const FRAME_MIN = 5; // Laenge eines Frames

// Einheiten und Intensitaetsschwellen (mm/h).
export const MMH_PER_UNIT = 0.12; // 0,01 mm pro 5 min -> mm/h
export const RAIN_MIN_MMH = 0.3; // darunter gilt Rauschen, also trocken
export const LIGHT_MAX_MMH = 2.5; // bis hier "leicht"
export const MODERATE_MAX_MMH = 10; // bis hier "maessig"
export const STRONG_MAX_MMH = 50; // bis hier "stark", darueber "sehr stark"

// Nachbarschaft und Ereignisbildung.
export const NEAR_WINDOW = 3; // Kantenlaenge bis 60 min Vorlauf
export const FAR_WINDOW = 5; // Kantenlaenge ab 60 min Vorlauf
export const UNCERTAIN_AFTER_MIN = 60; // ab hier gilt ein Frame als Tendenz
export const MIN_EVENT_FRAMES = 2; // kuerzere Regenphasen sind Ausreisser
export const MAX_GAP_FRAMES = 1; // so viele trockene Frames ueberbrueckt ein Ereignis

// Datenalter.
export const STALE_MIN = 15; // Datenalter, ab dem gewarnt wird
export const VERY_STALE_MIN = 30; // Datenalter, ab dem die Vorhersage unbrauchbar ist

// Refresh und Netz.
export const REFRESH_MS = 300000; // Intervall bei sichtbarer App
export const MIN_REFETCH_MS = 300000; // juengere Ergebnisse nicht neu laden
export const FETCH_TIMEOUT_MS = 10000;

// Geolocation.
export const GEO_MAX_AGE_MS = 300000; // maximumAge fuer Geolocation
export const GEO_TIMEOUT_MS = 10000;
export const COORD_DECIMALS = 3; // Rundung der Koordinaten vor der Anfrage

// Buendelung fuer die reinen Module. computeNowcast bekommt dieses Objekt,
// damit Tests einzelne Werte ueberschreiben koennen.
export const CONFIG = {
  FRAME_MIN,
  HORIZON_MIN,
  MMH_PER_UNIT,
  RAIN_MIN_MMH,
  LIGHT_MAX_MMH,
  MODERATE_MAX_MMH,
  STRONG_MAX_MMH,
  NEAR_WINDOW,
  FAR_WINDOW,
  UNCERTAIN_AFTER_MIN,
  MIN_EVENT_FRAMES,
  MAX_GAP_FRAMES,
  STALE_MIN,
  VERY_STALE_MIN,
};
