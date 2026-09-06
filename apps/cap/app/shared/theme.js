/*
 * Theme selection, for every page in the product.
 *
 * It existed on one screen. Choosing dark in the chat and then opening any
 * admin list threw a white page at you, which reads as a bug in the product
 * rather than as a setting that only covers a third of it.
 *
 * Two kinds of page have to agree:
 *
 *   the hand-written shells (Insights, Admin, Monitoring) theme themselves
 *     through the data-theme attribute that fiori.css already keys on;
 *   the nineteen Fiori Elements apps are UI5, which owns its own stylesheet
 *     and has to be told the theme name before it boots.
 *
 * One preference in localStorage drives both, so the choice survives the jump
 * from the chat into a list and back.
 *
 * MUST be loaded synchronously in <head>, before the UI5 bootstrap and before
 * any content renders. A deferred script paints the wrong theme first and then
 * corrects it, which is a visible flash on every navigation.
 */
(function () {
  "use strict";

  var KEY = "fp.theme";
  var ORDER = ["system", "light", "dark"];
  var LABEL = { system: "Auto", light: "Light", dark: "Dark" };
  var TITLE = {
    system: "Theme: follow the operating system",
    light: "Theme: always light",
    dark: "Theme: always dark",
  };

  // A private window throws on both read and write, and a browser with site
  // data blocked throws on access alone. Neither is a reason not to render.
  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return ORDER.indexOf(v) >= 0 ? v : "system";
    } catch (e) {
      return "system";
    }
  }
  function write(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* nothing to do */ }
  }

  function prefersDark() {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function isDark(mode) {
    return mode === "dark" || (mode === "system" && prefersDark());
  }

  var mode = read();

  // --- phase 1: before paint ------------------------------------------------

  // "system" stamps nothing, so fiori.css falls through to its media query.
  // Stamping data-theme="system" would match neither block and produce light
  // tokens on a dark machine.
  if (mode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);

  // UI5 reads this global while bootstrapping. Set unconditionally: on a page
  // with no UI5 it is an unread object, which costs nothing, and testing for a
  // bootstrap tag that has not been parsed yet cannot work.
  window["sap-ui-config"] = window["sap-ui-config"] || {};
  window["sap-ui-config"].theme = isDark(mode) ? "sap_horizon_dark" : "sap_horizon";

  /** Tell a booted UI5 to change theme without a reload. */
  function applyUi5(next) {
    var name = isDark(next) ? "sap_horizon_dark" : "sap_horizon";
    try {
      // UI5 2.x moved this to the Theming module; 1.x has it on the core.
      // Which one is present depends on the CDN's current release, so try the
      // modern path first and fall back rather than pinning a version.
      if (window.sap && sap.ui && typeof sap.ui.require === "function") {
        sap.ui.require(["sap/ui/core/Theming"], function (Theming) {
          if (Theming && Theming.setTheme) Theming.setTheme(name);
        }, function () {
          if (sap.ui.getCore) sap.ui.getCore().applyTheme(name);
        });
        return;
      }
    } catch (e) { /* fall through */ }
    try {
      if (window.sap && sap.ui && sap.ui.getCore) sap.ui.getCore().applyTheme(name);
    } catch (e) { /* UI5 not on this page */ }
  }

  function set(next) {
    mode = next;
    write(next);
    if (next === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    applyUi5(next);
    render();
    // Other tabs of the same app follow through the storage event below.
  }

  // --- phase 2: the control -------------------------------------------------

  var group = null;

  function render() {
    if (!group) return;
    var buttons = group.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].dataset.mode === mode;
      buttons[i].setAttribute("aria-checked", on ? "true" : "false");
      buttons[i].className = on ? "fd-theme__opt is-on" : "fd-theme__opt";
    }
  }

  function build() {
    var el = document.createElement("div");
    el.className = "fd-theme";
    el.setAttribute("role", "radiogroup");
    el.setAttribute("aria-label", "Colour theme");
    ORDER.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.mode = m;
      b.className = "fd-theme__opt";
      b.setAttribute("role", "radio");
      b.title = TITLE[m];
      b.textContent = LABEL[m];
      b.addEventListener("click", function () { set(m); });
      el.appendChild(b);
    });
    return el;
  }

  /*
   * The nineteen Fiori Elements pages carry no product chrome at all: opened
   * from a tile, they are a bare UI5 list on a blank page, with no name, no
   * navigation, and no way back but the browser button. They also do not load
   * fiori.css, because it styles `body` and that fights UI5's own layout.
   *
   * So this builds the shell for them, styles and all. The colours repeat
   * fiori.css's tokens under different names rather than importing it, and use
   * the same three states: bare :root is light, the media query covers "Auto"
   * on a dark machine, and the [data-theme] block lets an explicit choice win.
   */
  var SHELL_CSS =
    ".fp-shell{position:fixed;top:0;left:0;right:0;height:2.75rem;z-index:9999;display:flex;align-items:center;" +
    "gap:.75rem;padding:0 .75rem;background:var(--fp-shell);border-bottom:1px solid var(--fp-border);" +
    "font-family:'72','72full',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:.8125rem;" +
    "color:var(--fp-text);box-sizing:border-box}" +
    ".fp-shell__mark{width:1.5rem;height:1.5rem;flex:0 0 auto;border-radius:.375rem;color:#fff;" +
    "background:linear-gradient(135deg,#12307E,#2E86F0);display:grid;place-items:center}" +
    ".fp-shell__mark svg{width:80%;height:80%;display:block}" +
    ".fp-shell__brand{font-size:.9375rem;font-weight:700;white-space:nowrap;text-decoration:none;color:var(--fp-text)}" +
    ".fp-shell__brand i{font-style:normal;color:var(--fp-accent)}" +
    ".fp-shell__page{color:var(--fp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".fp-shell__gap{flex:1 1 auto}" +
    ".fp-shell__nav{display:flex;gap:.125rem}" +
    ".fp-shell__nav a{color:var(--fp-text);text-decoration:none;padding:.3125rem .5rem;border-radius:.375rem;white-space:nowrap}" +
    ".fp-shell__nav a:hover{background:var(--fp-bg)}" +
    ".fd-theme{display:inline-flex;background:var(--fp-bg);border:1px solid var(--fp-border);border-radius:.375rem;" +
    "padding:.0625rem;gap:.0625rem}" +
    ".fd-theme__opt{font:inherit;font-size:.6875rem;line-height:1;cursor:pointer;border:0;background:transparent;" +
    "color:var(--fp-muted);padding:.25rem .4375rem;border-radius:.3125rem}" +
    ".fd-theme__opt:hover{color:var(--fp-text)}" +
    ".fd-theme__opt.is-on{background:var(--fp-accent);color:#fff}" +
    /* The app keeps its full-height layout and simply starts below the bar.
       border-box means the padding comes out of the 100%, so nothing is
       pushed off the bottom and no inner scroll container is displaced. */
    "body.sapUiBody>#app{height:100%;padding-top:2.75rem;box-sizing:border-box}" +
    "@media (max-width:34rem){.fp-shell__page{display:none}}" +
    ":root{--fp-bg:#f5f6f7;--fp-shell:#fff;--fp-border:#d9d9d9;--fp-text:#1d2d3e;--fp-muted:#556b82;--fp-accent:#0070f2}" +
    "@media (prefers-color-scheme:dark){:root:not([data-theme='light']){--fp-bg:#12171c;--fp-shell:#1c2228;" +
    "--fp-border:#3a4552;--fp-text:#eaecee;--fp-muted:#a9b4bf;--fp-accent:#4db1ff}}" +
    ":root[data-theme='dark']{--fp-bg:#12171c;--fp-shell:#1c2228;--fp-border:#3a4552;--fp-text:#eaecee;" +
    "--fp-muted:#a9b4bf;--fp-accent:#4db1ff}";

  var MARK =
    '<svg viewBox="2.5 1.9 57.7 57.7" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M53.79 38.4 A21.5 21.5 0 0 1 25.94 49.93 L15 53 L17.06 43.24 A21.5 21.5 0 1 1 55.42 31.87" stroke-width="4.6"/>' +
    '<path d="M6.5 22 V42" stroke-width="6"/><circle cx="25.5" cy="34" r="6.3" stroke-width="4"/>' +
    '<path d="M48 15 L40 35 H57" stroke-width="4.4"/><path d="M48 15 V46" stroke-width="4.4"/>' +
    '<path d="M29.95 29.55 L36.5 21.5" stroke-width="3.2" stroke="#8CC8FF"/></g>' +
    '<circle cx="38" cy="20" r="3.3" fill="#8CC8FF"/><circle cx="25.5" cy="34" r="2.6" fill="#8CC8FF"/></svg>';

  function injectShellCss() {
    if (document.getElementById("fp-theme-css")) return;
    var s = document.createElement("style");
    s.id = "fp-theme-css";
    s.textContent = SHELL_CSS;
    document.head.appendChild(s);
  }

  function buildShell() {
    var bar = document.createElement("div");
    bar.className = "fp-shell";

    var mark = document.createElement("span");
    mark.className = "fp-shell__mark";
    mark.innerHTML = MARK;

    var brand = document.createElement("a");
    brand.className = "fp-shell__brand";
    brand.href = "/admin/index.html";
    brand.innerHTML = 'Intelli<i>Ops4</i>';
    brand.title = "Back to the IntelliOps4 launchpad";

    // The <title> is the console's own name ("Users", "Cache Policies"), which
    // is the one thing the page never says on screen.
    var page = document.createElement("span");
    page.className = "fp-shell__page";
    page.textContent = document.title || "";

    var gap = document.createElement("span");
    gap.className = "fp-shell__gap";

    var nav = document.createElement("nav");
    nav.className = "fp-shell__nav";
    [["Insights", "/insights/index.html"], ["Admin", "/admin/index.html"], ["Monitoring", "/dashboard/index.html"]]
      .forEach(function (pair) {
        var a = document.createElement("a");
        a.href = pair[1];
        a.textContent = pair[0];
        nav.appendChild(a);
      });

    bar.appendChild(mark);
    bar.appendChild(brand);
    bar.appendChild(page);
    bar.appendChild(gap);
    bar.appendChild(nav);
    return bar;
  }

  function mount() {
    if (group) return;
    group = build();

    var shell = document.querySelector(".fd-shellbar");
    if (shell) {
      // Before the user block, so the avatar and quota stay at the end where
      // Fiori puts them.
      var user = shell.querySelector(".fd-shellbar__user, .fd-shellbar__avatar");
      if (user) shell.insertBefore(group, user);
      else shell.appendChild(group);
    } else {
      injectShellCss();
      var bar = buildShell();
      bar.appendChild(group);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // Someone on "Auto" whose machine switches at sunset should follow it, and
  // the UI5 stylesheet will not change on its own.
  if (typeof matchMedia === "function") {
    var mq = matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () { if (mode === "system") applyUi5("system"); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // Changing the theme in the chat should not leave an admin list open in
  // another tab on the old one.
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    var next = ORDER.indexOf(e.newValue) >= 0 ? e.newValue : "system";
    if (next === mode) return;
    mode = next;
    if (next === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    applyUi5(next);
    render();
  });

  window.fpTheme = { get: function () { return mode; }, set: set };
})();
