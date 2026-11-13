// GitHub usernames can be changed, the account number behind them can't. every mod keeps both:
// authorNum decides who owns it, authorId (the username) is only kept current for links and the
// uploads-folder check. a rename must never cost anyone their mods.

export function owns(mod, login, num) {
  // mods from before numbers were kept fall back to the username until the daily robot fills them in
  if (mod.authorNum) return Number(mod.authorNum) === Number(num);
  return String(mod.authorId || "").toLowerCase() === String(login).toLowerCase();
}

// moves every mod under this account number to its current username. returns the ids that moved
export function followRename(catalog, login, num) {
  const moved = [];
  for (const m of catalog.mods)
    if (m.authorNum && Number(m.authorNum) === Number(num) && m.authorId !== login) { m.authorId = login; moved.push(m.id); }
  return moved;
}

// how many downloads a version's file already had the moment it went live. those were our own
// checks (virus scan, BSMK Admin, the robots), so the launcher only counts players after this
export async function liveCount(downloadUrl, token) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)/i.exec(String(downloadUrl || ""));
  if (!m) return 0;
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/tags/${m[3]}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-store" },
    });
    if (!r.ok) return 0;
    const rel = await r.json();
    const asset = (rel.assets || []).find(a => a.name.toLowerCase() === decodeURIComponent(m[4]).toLowerCase());
    return asset ? asset.download_count : 0;
  } catch { return 0; }
}

// banned.json next to index.json, kept by hand. the number is what counts, a ban has to survive a rename
// too. a missing or broken list bans nobody
export async function isBanned(repo, token, login, num) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/banned.json`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-store" },
    });
    if (!r.ok) return false;
    const list = JSON.parse(Buffer.from((await r.json()).content, "base64").toString("utf8")).Users || [];
    return list.some(u => (u.num && Number(u.num) === Number(num)) || String(u.login || "").toLowerCase() === String(login).toLowerCase());
  } catch { return false; }
}
