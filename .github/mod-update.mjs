// Runs inside GitHub Actions on the store repo (see mod-update.yml). A new version of a mod that's
// already on the store goes live by itself if it comes from the mod's own author and the scan below
// finds nothing worrying. Anything that trips the scan is held for one of us. Brand-new mods never
// come through here, they still get a full read by hand (tools/Approve).
// Dry run on a PC: node mod-update.mjs --dry <event.json> <index.json> [trusted.json] [killed.json]
//   (downloads, writes nothing, posts nothing)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scanFile, saveScan, describe } from "./virus-scan.mjs";
import { owns, followRename, liveCount, isBanned } from "./authors.mjs";

const dry = process.argv[2] === "--dry";
const repo = process.env.GITHUB_REPOSITORY || "1MR1C1/BSMK-mods";
const token = process.env.GITHUB_TOKEN || "";
const webhook = process.env.DISCORD_WEBHOOK || "";
const api = "https://api.github.com";

const event = JSON.parse(readFileSync(dry ? process.argv[3] : process.env.GITHUB_EVENT_PATH, "utf8"));
const issue = event.issue;
const opener = issue.user.login;
const openerNum = issue.user.id;
// a label can only be added by someone with write access to the store, so "approved" means one of us
const ownerApproved = event.action === "labeled" && event.label?.name === "approved";

// same list as listing-edit.mjs and the launcher's CommentFilter.cs
const explicit = /\b(porn|pornhub|xxx|nsfw|sex|sexual|nude|nudes|naked|boobs|tits|titty|nipple|penis|vagina|pussy|dick|cock|cum|blowjob|handjob|masturbat\w*|orgasm|hentai|rape|rapist|pedo|paedo|pedophile|paedophile|cp|loli|shota|fuck\w*|f4f|slut|whore|cunt|anal|creampie|deepthroat|bukkake|fetish|bdsm|onlyfans)\b/i;

// names a Block Story mod has no business using. .NET keeps every type and method a DLL calls as a
// plain zero-ended word inside the file, so an exact-word match finds them without decompiling.
// it won't stop someone determined to hide things, it's there to catch the obvious, and the author
// already passed a full check by hand on their first mod.
// trusted authors only get held for the first two, the rest is normal for some mods (update checks,
// settings in the registry) and they've earned the benefit of the doubt
const alwaysHold = new Set(["starts other programs", "loads hidden code"]);
const watched = {
  "goes on the internet": ["WebClient", "HttpClient", "HttpWebRequest", "WebRequest", "UnityWebRequest", "Socket", "TcpClient", "UdpClient", "TcpListener", "Dns", "Ping", "SmtpClient"],
  "starts other programs": ["Process", "ProcessStartInfo"],
  "loads hidden code": ["LoadFrom", "LoadFile", "UnsafeLoadFrom", "CompileAssemblyFromSource", "DllImportAttribute"],
  "reads the registry": ["Registry", "RegistryKey"],
};

function gh(path, method = "GET", body) {
  return fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-mod-update" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function readRequest(body) {
  const a = body.indexOf("<!--BSMK"), b = body.indexOf("BSMK-->");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a + 8, b).trim()); } catch { return null; }
}

// small owner-kept lists next to index.json: trusted.json = authors whose updates skip the hold unless
// the scan finds something red, killed.json = mod files the store team pulled (kill switch / roll back)
async function readList(file, fallback) {
  try {
    if (dry) {
      const path = file === "trusted.json" ? process.argv[5] : process.argv[6];
      return path ? JSON.parse(readFileSync(path, "utf8")) : fallback;
    }
    const r = await gh(`/repos/${repo}/contents/${file}`);
    if (!r.ok) return fallback;
    return JSON.parse(Buffer.from((await r.json()).content, "base64").toString("utf8"));
  } catch { return fallback; }
}

async function readIndex() {
  if (dry) return { sha: "dry", catalog: JSON.parse(readFileSync(process.argv[4], "utf8")) };
  const r = await gh(`/repos/${repo}/contents/index.json`);
  if (!r.ok) throw new Error("couldn't read index.json: " + r.status);
  const j = await r.json();
  return { sha: j.sha, catalog: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}

// "1.2" vs "1.10" has to compare as numbers, not text
function newer(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n) || 0), pb = String(b).split(".").map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function scan(bytes) {
  const words = new Set(bytes.toString("latin1").split("\0"));
  const found = [];
  for (const [what, names] of Object.entries(watched)) {
    const hits = names.filter(n => words.has(n));
    if (hits.length) found.push({ text: `${what} (${hits.join(", ")})`, serious: alwaysHold.has(what) });
  }
  // deleting a file is fine on its own (configs), deleting whole folders isn't
  if (words.has("Directory") && words.has("Delete")) found.push({ text: "can delete folders (Directory.Delete)", serious: false });
  return found;
}

async function say(text, close, labels = []) {
  if (dry) { console.log(`[issue] ${text}${close ? " (close)" : ""} ${labels.join(",")}`); return; }
  await gh(`/repos/${repo}/issues/${issue.number}/comments`, "POST", { body: text });
  if (labels.length) await gh(`/repos/${repo}/issues/${issue.number}/labels`, "POST", { labels });
  if (close) {
    await gh(`/repos/${repo}/issues/${issue.number}`, "PATCH", { state: "closed", state_reason: "completed" });
    await gh(`/repos/${repo}/issues/${issue.number}/lock`, "PUT", { lock_reason: "resolved" });
  }
}

async function discord(title, lines) {
  const content = `**${title}**\n${lines.join("\n")}\n${issue.html_url}`.slice(0, 1990);
  if (dry) { console.log(`[discord] ${content}`); return; }
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

async function main() {
  const wanted = readRequest(issue.body || "");
  if (!wanted || !wanted.id) {
    await say("Couldn't read this update. Please send it again from the BSMK Launcher.", true, ["rejected"]);
    return;
  }
  if (!dry && await isBanned(repo, token, opener, openerNum)) {
    await say("This account can't send updates to the BSMK store.", true, ["rejected"]);
    return;
  }

  // the file is checked once, outside the retry loop, it doesn't change if index.json does
  const own = `https://github.com/${opener}/BSMK-mods-uploads/releases/download/`.toLowerCase();
  const refuse = async (why) => {
    await say(`Nothing was changed: ${why}`, true, ["rejected"]);
    await discord(`Mod update refused — ${wanted.name || wanted.id}`, [`by ${opener}`, `• ${why}`]);
  };
  if (typeof wanted.downloadUrl !== "string" || !wanted.downloadUrl.toLowerCase().startsWith(own))
    return refuse("the mod file has to come from your own BSMK-mods-uploads repo.");
  const dl = await fetch(wanted.downloadUrl);
  if (!dl.ok) return refuse(`couldn't download the mod file (${dl.status}).`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (sha !== String(wanted.sha256 || "").toUpperCase())
    return refuse("the mod file doesn't match what the launcher sent. Send it again.");

  // a file the store team pulled never comes back through an update, even under a new version number
  const killed = (await readList("killed.json", { Mods: [] })).Mods || [];
  const pulled = killed.find(k => String(k.id).toLowerCase() === String(wanted.id).toLowerCase() &&
    (!k.sha256?.length || k.sha256.some(h => String(h).toUpperCase() === sha)));
  if (pulled && !ownerApproved)
    return refuse(pulled.sha256?.length ? "that exact file was pulled from the store. Send a fixed version."
      : "this mod has been switched off by the store team. Ask on the Discord.");
  // a virus hit holds the update even for a trusted author; the scan is saved for BSMK Admin to show
  const virus = await scanFile(bytes, sha);
  if (!dry) await saveScan(virus).catch(e => console.error(e));
  const virusLines = describe(virus);
  if (dry) console.log("[virus]", virus.verdict, virusLines.join(" | "));
  const startCount = dry ? 0 : await liveCount(wanted.downloadUrl, token);
  const trusted = ((await readList("trusted.json", { Users: [] })).Users || []).some(u => String(u).toLowerCase() === opener.toLowerCase());

  for (let attempt = 0; attempt < 5; attempt++) {
    const { sha: indexSha, catalog } = await readIndex();
    const current = catalog.mods.find(m => m.id.toLowerCase() === String(wanted.id).toLowerCase());
    if (!current)
      return refuse(`there's no mod \`${wanted.id}\` on the store yet. New mods are reviewed by hand, send it from the Upload page.`);
    const renamed = followRename(catalog, opener, openerNum);
    if (!owns(current, opener, openerNum)) {
      await say(`Only the mod's own author (${current.authorId}) can update it.`, true, ["rejected"]);
      await discord(`Mod update REFUSED — ${current.name}`, [`${opener} tried to update a mod owned by ${current.authorId}.`]);
      return;
    }
    if (!newer(wanted.version, current.version))
      return refuse(`the version has to go up (store has v${current.version}, this is v${wanted.version}), otherwise players never get told there's an update.`);

    const found = scan(bytes);
    const held = found.filter(f => !trusted || f.serious).map(f => "code " + f.text);
    const waved = found.filter(f => trusted && !f.serious).map(f => "code " + f.text);
    for (const key of ["name", "summary", "description", "changelog"])
      if (typeof wanted[key] === "string" && explicit.test(wanted[key])) held.push(`${key} tripped the word filter`);
    if (virus.verdict === "infected" || virus.verdict === "suspicious") held.push(`virus scan: ${virusLines.join(" / ")}`);
    const head = [`by ${opener}${trusted ? " (trusted)" : ""}`, `v${current.version} → v${wanted.version}`, ...(wanted.changelog ? [`changes: ${String(wanted.changelog).slice(0, 300)}`] : []),
      ...waved.map(w => `ℹ let through for a trusted author: ${w}`),
      ...(virus.verdict === "not scanned" ? ["ℹ virus scan didn't run: " + virusLines.join(" / ")] : [])];
    if (held.length && !ownerApproved) {
      await say("Thanks! This update is waiting for a quick look from the store team before it goes live.", false, ["held"]);
      await discord(`Mod update HELD — ${current.name}`, [...head, ...held.map(h => "⚠ " + h), `Download: ${wanted.downloadUrl}`,
        "Add the **approved** label to the issue to let it through, or close it to drop it."]);
      return;
    }

    // the update can change what the mod is, but never who owns it or what it has earned
    const keep = { id: current.id, authorId: current.authorId, authorNum: current.authorNum || openerNum,
      countFrom: { ...(current.countFrom || {}), [wanted.version]: startCount }, createdUtc: current.createdUtc, downloads: current.downloads,
      rating: current.rating, ratingCount: current.ratingCount, verified: current.verified, featured: current.featured,
      flagged: current.flagged };
    const updated = { ...current, ...wanted, ...keep };
    if (!Array.isArray(wanted.screenshots) || wanted.screenshots.length === 0) updated.screenshots = current.screenshots;
    if (!wanted.iconUrl) updated.iconUrl = current.iconUrl;
    updated.updatedUtc = new Date().toISOString();
    catalog.mods[catalog.mods.indexOf(current)] = updated;
    catalog.updatedUtc = updated.updatedUtc;

    if (dry) {
      console.log("[index] would write:", JSON.stringify(updated, null, 2));
    } else {
      const put = await gh(`/repos/${repo}/contents/index.json`, "PUT", {
        message: `store: ${current.id} v${wanted.version} by ${opener}`,
        content: Buffer.from(JSON.stringify(catalog, null, 2)).toString("base64"),
        sha: indexSha,
      });
      // 409 = something else wrote index.json since we read it. read again and redo.
      if (put.status === 409) continue;
      if (!put.ok) throw new Error("couldn't write index.json: " + put.status + " " + await put.text());
    }
    await say(`Done, v${wanted.version} is live. It can take a few minutes to show in everyone's launcher.`, true, ["applied"]);
    await discord(`Mod update live — ${current.name}`, [...head, ...(ownerApproved ? ["(approved by hand)"] : []),
      ...(renamed.length ? [`ℹ ${opener} renamed their GitHub, moved ${renamed.length} mod(s) to the new name`] : [])]);
    return;
  }
  throw new Error("index.json kept changing under us, gave up after 5 tries");
}

main().catch(async e => {
  console.error(e);
  try { await discord("Mod update FAILED", [String(e.message || e)]); } catch {}
  process.exit(1);
});
