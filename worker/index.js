// Starts the "Trackr check" GitHub workflow every 5 minutes (see wrangler.toml), because GitHub's
// own cron can lag by hours. GH_TOKEN is a Cloudflare secret: a fine-grained token for this one
// repo with only "Actions: read and write". Set it with `npx wrangler secret put GH_TOKEN`.
export default {
  async scheduled(_event, env) {
    const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/check.yml/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "trackr-alert-trigger",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    // Shows up as a failed cron run in the Cloudflare dashboard (Workers → trackr-trigger → Logs).
    if (!r.ok) throw new Error(`GitHub dispatch failed: ${r.status} ${await r.text()}`);
  },
};
