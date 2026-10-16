/*
 * xheatgrid MAIN-world bridge (manifest "world": "MAIN", run_at document_start).
 *
 * The isolated content script cannot see page JS (fetch, XHR, React fiber expandos), so
 * this tiny script reads the numbers the page already has and forwards them as
 * postMessage rows. It never modifies page behaviour: wrappers always return the
 * original result and swallow their own errors.
 *
 * Data sources (best effort; response shapes are UNVERIFIED guesses, treated as untrusted):
 *   (a) network: JSON responses whose URL looks like analytics, scanned for per-day rows
 *   (b) React:   props.data of the Recharts chart component, found via __reactFiber$ expando
 * The SVG geometry parser in the isolated script remains the guaranteed fallback.
 */
(function () {
  "use strict";

  const OUT = "xheatgrid-bridge";
  const IN = "xheatgrid-content";
  const MAX_TEXT = 3 * 1024 * 1024;
  const MAX_ROWS = 2000;
  const MAX_NODES = 20000;

  const POSTS_KEY = /^(posts?|tweets?|post_?counts?|tweet_?counts?|original_?(posts?|tweets?))$/i;
  const REPLIES_KEY = /^(replies|reply|reply_?counts?|replies_?counts?)$/i;
  const DATE_KEY_HINT = /(date|day|time|timestamp|ts)/i;

  // ---------------------------------------------------------------- parsing

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** Epoch ms/s, ISO date or ISO datetime -> "YYYY-MM-DD" (UTC calendar day) or null. */
  function toDateKey(value) {
    let ms = null;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value >= 1e11 && value < 1e14) {
        ms = value;
      } else if (value >= 1e9 && value < 1e11) {
        ms = value * 1000;
      }
    } else if (typeof value === "string") {
      const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (plain) {
        ms = Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
      } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) {
        const parsed = Date.parse(value);
        ms = Number.isNaN(parsed) ? null : parsed;
      }
    }
    if (ms === null) {
      return null;
    }
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    return year >= 2000 && year <= 2100 ? `${year}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : null;
  }

  function count(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : null;
  }

  /**
   * Interpret an array of per-day objects. Returns rows [{date, posts, replies}] or null.
   * hints = { postsKey, repliesKey, dateKey } (optional, from Recharts dataKey props).
   */
  function rowsFromArray(array, hints) {
    if (!Array.isArray(array) || array.length < 1 || array.length > MAX_ROWS) {
      return null;
    }
    const sample = array.find((item) => item && typeof item === "object" && !Array.isArray(item));
    if (!sample) {
      return null;
    }
    const keys = Object.keys(sample);
    const h = hints || {};
    const postsKey = h.postsKey && keys.includes(h.postsKey) ? h.postsKey : keys.find((k) => POSTS_KEY.test(k));
    const repliesKey = h.repliesKey && keys.includes(h.repliesKey) ? h.repliesKey : keys.find((k) => REPLIES_KEY.test(k));
    if (!postsKey && !repliesKey) {
      return null;
    }
    const dateKey =
      (h.dateKey && keys.includes(h.dateKey) && toDateKey(sample[h.dateKey]) ? h.dateKey : null) ||
      keys.find((k) => DATE_KEY_HINT.test(k) && toDateKey(sample[k])) ||
      keys.find((k) => toDateKey(sample[k]));
    if (!dateKey) {
      return null;
    }
    const rows = [];
    const seen = new Set();
    for (const item of array) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const date = toDateKey(item[dateKey]);
      const posts = postsKey ? count(item[postsKey]) : null;
      const replies = repliesKey ? count(item[repliesKey]) : null;
      if (!date || seen.has(date) || (posts === null && replies === null)) {
        continue;
      }
      seen.add(date);
      rows.push({ date, posts, replies });
    }
    if (rows.length < 1 || rows.length < array.length * 0.8) {
      return null;
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    return rows;
  }

  /** Breadth-first search of untrusted JSON for the best per-day array. */
  function extractRowsFromJson(json) {
    let best = null;
    let visited = 0;
    const queue = [json];
    while (queue.length && visited < MAX_NODES) {
      const node = queue.shift();
      visited += 1;
      if (Array.isArray(node)) {
        const rows = rowsFromArray(node);
        if (rows && (!best || rows.length > best.length)) {
          best = rows;
        }
        for (const child of node.slice(0, 50)) {
          if (child && typeof child === "object") {
            queue.push(child);
          }
        }
      } else if (node && typeof node === "object") {
        for (const key of Object.keys(node)) {
          const child = node[key];
          if (child && typeof child === "object") {
            queue.push(child);
          }
        }
      }
    }
    return best;
  }

  function collectDataKeys(children, out, depth) {
    if (!children || depth > 6) {
      return;
    }
    if (Array.isArray(children)) {
      for (const child of children) {
        collectDataKeys(child, out, depth + 1);
      }
      return;
    }
    if (typeof children === "object" && children.props) {
      const dataKey = children.props.dataKey;
      if (typeof dataKey === "string") {
        out.push(dataKey);
      }
      collectDataKeys(children.props.children, out, depth + 1);
    }
  }

  /** Walk up from a .recharts-wrapper fiber to the chart component holding props.data. */
  function rowsFromFiber(startFiber) {
    let fiber = startFiber;
    for (let depth = 0; fiber && depth < 80; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && Array.isArray(props.data)) {
        const dataKeys = [];
        collectDataKeys(props.children, dataKeys, 0);
        const hints = {
          postsKey: dataKeys.find((k) => POSTS_KEY.test(k)),
          repliesKey: dataKeys.find((k) => REPLIES_KEY.test(k))
        };
        const rows = rowsFromArray(props.data, hints);
        if (rows) {
          return rows;
        }
      }
    }
    return null;
  }

  function scanReact(doc) {
    for (const wrapper of doc.querySelectorAll(".recharts-wrapper")) {
      const key = Object.keys(wrapper).find((k) => k.startsWith("__reactFiber$"));
      if (!key) {
        continue;
      }
      const rows = rowsFromFiber(wrapper[key]);
      if (rows) {
        return rows;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- wiring

  function isCandidateUrl(rawUrl, base) {
    try {
      const url = new URL(rawUrl, base);
      const hostOk = /(^|\.)(x|twitter)\.com$/i.test(url.hostname);
      return hostOk && /analytic/i.test(url.pathname + url.search);
    } catch (error) {
      return false;
    }
  }

  function install(win) {
    let lastMessage = null;

    function post(via, rows, endpoint) {
      lastMessage = { source: OUT, type: "xheatgrid:rows", via, endpoint: endpoint || "", rows };
      win.postMessage(lastMessage, win.location.origin);
    }

    function handleText(text, url) {
      if (typeof text !== "string" || text.length > MAX_TEXT) {
        return;
      }
      try {
        const rows = extractRowsFromJson(JSON.parse(text));
        if (rows) {
          post("network", rows, new URL(url, win.location.href).pathname);
        }
      } catch (error) {
        /* not JSON or not ours: ignore */
      }
    }

    if (typeof win.fetch === "function") {
      const originalFetch = win.fetch;
      win.fetch = function fetchWithXheatgrid(...args) {
        const result = originalFetch.apply(this, args);
        try {
          const first = args[0];
          const url = typeof first === "string" ? first : first && first.url;
          if (url && isCandidateUrl(url, win.location.href)) {
            result
              .then((response) => {
                if (response && response.ok && /json/i.test(response.headers.get("content-type") || "")) {
                  response.clone().text().then((text) => handleText(text, url)).catch(() => {});
                }
              })
              .catch(() => {});
          }
        } catch (error) {
          /* never break the page */
        }
        return result;
      };
    }

    if (win.XMLHttpRequest && win.XMLHttpRequest.prototype) {
      const proto = win.XMLHttpRequest.prototype;
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const urls = new WeakMap();
      proto.open = function openWithXheatgrid(method, url, ...rest) {
        try {
          urls.set(this, String(url));
        } catch (error) {
          /* ignore */
        }
        return originalOpen.call(this, method, url, ...rest);
      };
      proto.send = function sendWithXheatgrid(...args) {
        try {
          const url = urls.get(this);
          if (url && isCandidateUrl(url, win.location.href)) {
            this.addEventListener("load", () => {
              try {
                if (this.status >= 200 && this.status < 300) {
                  const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
                  handleText(text, url);
                }
              } catch (error) {
                /* ignore */
              }
            });
          }
        } catch (error) {
          /* ignore */
        }
        return originalSend.apply(this, args);
      };
    }

    // The isolated world cannot hook history.*; report SPA navigations from here.
    for (const name of ["pushState", "replaceState"]) {
      const original = win.history && win.history[name];
      if (typeof original === "function") {
        win.history[name] = function (...args) {
          const result = original.apply(this, args);
          try {
            win.postMessage({ source: OUT, type: "xheatgrid:navigate" }, win.location.origin);
          } catch (error) {
            /* ignore */
          }
          return result;
        };
      }
    }

    win.addEventListener("message", (event) => {
      const data = event.data;
      if (event.source !== win || !data || data.source !== IN || data.type !== "xheatgrid:scan-request") {
        return;
      }
      try {
        const rows = scanReact(win.document);
        if (rows) {
          post("react", rows, "");
        } else if (lastMessage) {
          win.postMessage(lastMessage, win.location.origin); // replay data seen before the content script loaded
        }
      } catch (error) {
        /* ignore */
      }
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { toDateKey, rowsFromArray, extractRowsFromJson, rowsFromFiber, scanReact, isCandidateUrl, install };
  }
  if (typeof window !== "undefined" && typeof document !== "undefined" && !(typeof module !== "undefined" && module.exports)) {
    install(window);
  }
})();
