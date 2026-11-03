// Script of the system check page (/status.html).

// Calls one endpoint and paints its box green (HTTP 2xx and status "ok") or red.
async function check(boxId, url) {
  const box = document.getElementById(boxId);
  box.className = "check";
  box.querySelector(".status").textContent = "checking...";
  let data = null;
  try {
    // Relative URL: the page and the API share the same origin (Caddy),
    // so this works on localhost, a LAN IP, Tailscale or a domain.
    const response = await fetch(url, { cache: "no-store" });
    const text = await response.text();
    try { data = JSON.parse(text); } catch { data = null; }
    const ok = response.ok && data && data.status === "ok";
    box.classList.add(ok ? "ok" : "fail");
    box.querySelector(".status").textContent = (ok ? "OK" : "FAIL") + " (HTTP " + response.status + ")";
    box.querySelector(".body").textContent = data ? JSON.stringify(data, null, 2) : text;
  } catch (err) {
    // fetch itself failed: Caddy unreachable, network down, etc.
    box.classList.add("fail");
    box.querySelector(".status").textContent = "FAIL (no response)";
    box.querySelector(".body").textContent = String(err);
  }
  return data;
}

async function runChecks() {
  check("api", "/api/health");
  const db = await check("db", "/api/health/db");
  const box = document.getElementById("db");
  box.querySelector(".pg").textContent = (db && db.postgresql_version) || "-";
  box.querySelector(".postgis").textContent = (db && db.postgis_version) || "-";
}

document.getElementById("again").addEventListener("click", runChecks);
runChecks();
