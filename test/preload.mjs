// Loaded with `node --import` before check.mjs. Makes the run fully offline without touching the
// code under test: Telegram calls go to a local mock, Trackr pages are served by page.route, and
// the clock can be faked with FAKE_NOW.
import { chromium } from "playwright";

const TG = process.env.MOCK_TG; // e.g. http://127.0.0.1:1234
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).replace("https://api.telegram.org", TG), opts);

if (process.env.FAKE_NOW) {
  const RealDate = Date;
  const fixed = new RealDate(process.env.FAKE_NOW).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  };
}

// MOCK_TRACKR is a JSON body for /programmes, or "TIMEOUT" to never answer.
const body = process.env.MOCK_TRACKR;
const launch = chromium.launch.bind(chromium);
chromium.launch = async (o) => {
  const b = await launch(o);
  const newPage = b.newPage.bind(b);
  b.newPage = async (...a) => {
    const p = await newPage(...a);
    await p.route("https://app.the-trackr.com/**", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.startsWith("/programmes")) {
        if (body === "TIMEOUT") return; // hang
        return route.fulfill({ status: 200, contentType: "application/json", body });
      }
      const type = u.pathname.split("/").pop();
      return route.fulfill({
        contentType: "text/html",
        body: `<script>fetch('/programmes?type=${type}&region=uk')</script>`,
      });
    });
    return p;
  };
  return b;
};
