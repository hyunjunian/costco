"use strict";

const CACHE_NAME = "costco-price-pwa-v9";
const DB_NAME = "costco-price-alerts";
const DB_VERSION = 1;
const DB_STORE = "kv";
const ALERT_CODES_KEY = "costco-alert-codes-v1";
const PRICE_SNAPSHOT_KEY = "costco-price-snapshot-v1";
const LAST_CHECK_KEY = "costco-last-background-check-v1";
const PRICE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
];

const SOURCES = {
  products: {
    csv: "https://docs.google.com/spreadsheets/d/1JhhzwsnZoQjzd1xksaqnNjuk2oVc5tjrCPbxNcWAUsk/gviz/tq?tqx=out:csv&sheet=products",
    columns: ["code", "name", "image", "stock"]
  },
  prices: {
    csv: "https://docs.google.com/spreadsheets/d/1JhhzwsnZoQjzd1xksaqnNjuk2oVc5tjrCPbxNcWAUsk/gviz/tq?tqx=out:csv&sheet=prices",
    columns: ["code", "price", "timestamp"]
  }
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // External APIs must surface network/CORS failures instead of receiving HTML.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        if (new URL(event.request.url).origin === self.location.origin) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "price-check") {
    event.waitUntil(checkPrices({ force: true }));
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CHECK_PRICES") {
    event.waitUntil(checkPrices({ force: false }));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "./index.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const sameOriginClient = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (sameOriginClient) {
        sameOriginClient.focus();
        if ("navigate" in sameOriginClient) return sameOriginClient.navigate(targetUrl);
        return sameOriginClient;
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

async function checkPrices(options) {
  const alertCodes = new Set((await getDbValue(ALERT_CODES_KEY, [])).map(cleanCode).filter(Boolean));
  if (!alertCodes.size) return;

  const now = Date.now();
  const lastCheck = await getDbValue(LAST_CHECK_KEY, 0);
  if (!options.force && now - lastCheck < PRICE_CHECK_INTERVAL_MS) return;

  const [products, prices] = await Promise.all([
    loadCsvSource("products"),
    loadCsvSource("prices")
  ]);
  const latestPrices = latestByCode(prices, "price");
  const previous = await getDbValue(PRICE_SNAPSHOT_KEY, {});
  const snapshot = {};
  const changes = [];

  products.forEach((product) => {
    const code = cleanCode(product.code);
    const priceRow = latestPrices.get(code);
    const currentPrice = priceRow ? toNumber(priceRow.price) : null;
    if (!code || currentPrice === null || !alertCodes.has(code)) return;

    const old = previous[code];
    if (old && old.price !== null && old.price !== currentPrice) {
      changes.push({
        code,
        name: product.name || "(이름 없음)",
        oldPrice: old.price,
        newPrice: currentPrice,
        direction: currentPrice > old.price ? "up" : "down"
      });
    }

    snapshot[code] = {
      price: currentPrice,
      basePrice: old ? old.basePrice : null,
      name: product.name || "(이름 없음)",
      updatedAt: priceRow && priceRow.timestamp ? String(priceRow.timestamp) : null
    };
  });

  await setDbValue(PRICE_SNAPSHOT_KEY, snapshot);
  await setDbValue(LAST_CHECK_KEY, now);
  await showPriceChangeNotifications(changes);
}

async function showPriceChangeNotifications(changes) {
  const permission = typeof Notification === "undefined" ? "default" : Notification.permission;
  if (!changes.length || permission !== "granted") return;

  const visibleChanges = changes.slice(0, 5);
  await Promise.all(visibleChanges.map((change) => self.registration.showNotification(
    change.direction === "down" ? "가격이 내려갔습니다" : "가격이 올랐습니다",
    {
      body: change.name + "\n" + money(change.oldPrice) + " -> " + money(change.newPrice),
      tag: "costco-price-" + change.code,
      icon: "icon.svg",
      badge: "icon.svg",
      data: {
        productCode: change.code,
        url: "http://costco.co.kr/p/" + encodeURIComponent(change.code)
      }
    }
  )));

  if (changes.length > visibleChanges.length) {
    await self.registration.showNotification("가격 변동 알림", {
      body: "추가 " + numberFormatter(changes.length - visibleChanges.length) + "개 상품의 가격이 바뀌었습니다.",
      tag: "costco-price-summary",
      icon: "icon.svg",
      badge: "icon.svg",
      data: { url: "./index.html" }
    });
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getDbValue(key, fallback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result === undefined ? fallback : request.result);
    request.onerror = () => reject(request.error);
  });
}

async function setDbValue(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadCsvSource(key) {
  const source = SOURCES[key];
  const response = await fetch(source.csv, { cache: "no-store" });
  if (!response.ok) throw new Error(key + " CSV response error: " + response.status);
  const text = await response.text();
  return rowsToObjects(parseCsv(text), source.columns);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === "\"" && next === "\"") {
        value += "\"";
        i += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => cell.trim() !== ""));
}

function rowsToObjects(rows, fallbackColumns) {
  if (!rows.length) return [];
  const first = rows[0].map((header) => String(header || "").trim().replace(/\s+/g, "").toLowerCase());
  const hasHeader = fallbackColumns.every((column) => first.includes(column.toLowerCase()));
  const headers = hasHeader ? rows[0].map((header) => String(header || "").trim()) : fallbackColumns;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows.map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = (row[index] || "").trim();
    });
    return item;
  });
}

function latestByCode(rows, valueKey) {
  const map = new Map();
  rows.forEach((row) => {
    const code = cleanCode(row.code);
    if (!code || toNumber(row[valueKey]) === null) return;
    const current = map.get(code);
    const nextDate = parseDate(row.timestamp);
    const currentDate = current ? parseDate(current.timestamp) : null;
    if (!current || compareDates(nextDate, currentDate) >= 0) map.set(code, row);
  });
  return map;
}

function cleanCode(value) {
  return String(value || "").trim();
}

function toNumber(value) {
  const cleaned = String(value || "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function parseDate(value) {
  if (!value) return null;
  const numeric = Number(String(value).trim());
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 100000000000 ? numeric : numeric * 1000;
    const numericDate = new Date(milliseconds);
    if (!Number.isNaN(numericDate.getTime())) return numericDate;
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  const normalized = String(value).replace(/\./g, "-").replace(/\s+/g, " ").trim();
  const fallback = new Date(normalized);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function compareDates(a, b) {
  const at = a ? a.getTime() : 0;
  const bt = b ? b.getTime() : 0;
  return at - bt;
}

function money(value) {
  return value === null ? "-" : new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0
  }).format(value);
}

function numberFormatter(value) {
  return new Intl.NumberFormat("ko-KR").format(value);
}
