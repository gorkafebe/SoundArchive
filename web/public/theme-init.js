// Runs before the app (see index.html). Applies the saved theme and language
// to <html> straight away. Same rules and storage keys as src/lib/theme.tsx
// and src/i18n/i18n.tsx; keep them in step.
(function () {
  var root = document.documentElement;
  var theme = "light";
  var language = null;
  try {
    theme = localStorage.getItem("sa.theme") || "light";
    language = localStorage.getItem("sa.language");
  } catch (e) {
    // Storage blocked: defaults.
  }
  if (theme === "system") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  if (language !== "es" && language !== "en") {
    var first = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    language = first.toLowerCase().indexOf("en") === 0 ? "en" : "es";
  }
  root.setAttribute("lang", language);
})();
