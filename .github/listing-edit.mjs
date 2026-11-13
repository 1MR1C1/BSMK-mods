// Runs inside GitHub Actions on the store repo (see listing-edit.yml). Also runnable on a PC for a
// dry run: node listing-edit.mjs --dry <event.json> <index.json>  (reads files, writes nothing, posts nothing)
import { readFileSync } from "node:fs";
import { owns, followRename, isBanned } from "./authors.mjs";

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

// only what changes how a listing LOOKS. the mod file, version, download link, fingerprint and
// earned stats are left alone, so a hijacked edit can never swap what people actually install.
const editable = ["name", "summary", "description", "tags", "category", "iconUrl", "screenshots", "videoUrl",
  "sourceUrl", "supportUrl", "donateUrl", "license", "deprecated", "featured", "gameVersions", "minGameVersion", "maxGameVersion"];

// same word list the launcher uses on comments (CommentFilter.cs). Block Story is mostly kids,
// so it errs on the side of holding something back for a human look
const explicit = /\b(porn|pornhub|xxx|nsfw|sex|sexual|nude|nudes|naked|boobs|tits|titty|nipple|penis|vagina|pussy|dick|cock|cum|blowjob|handjob|masturbat\w*|orgasm|hentai|rape|rapist|pedo|paedo|pedophile|paedophile|cp|loli|shota|fuck\w*|f4f|slut|whore|cunt|anal|creampie|deepthroat|bukkake|fetish|bdsm|onlyfans)\b/i;

const limits = { name: 60, summary: 200, description: 20000, tag: 40, tags: 12, screenshots: 12 };

function gh(path, method = "GET", body) {
  return fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-listing-edit" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function readRequest(body) {
  const a = body.indexOf("<!--BSMK"), b = body.indexOf("BSMK-->");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a + 8, b).trim()); } catch { return null; }
}

async function readIndex() {
  if (dry) return { sha: "dry", catalog: JSON.parse(readFileSync(process.argv[4], "utf8")) };
  const r = await gh(`/repos/${repo}/contents/index.json`);
  if (!r.ok) throw new Error("couldn't read index.json: " + r.status);
  const j = await r.json();
  return { sha: j.sha, catalog: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}

// pictures may only come from the author's own uploads repo (where the launcher puts them) or be
// ones already on the listing. stops a listing pulling in images from some random site.
function pictureOk(url, authorId, existing) {
  if (existing.includes(url)) return true;
  const own = `https://github.com/${authorId}/BSMK-mods-uploads/releases/download/`.toLowerCase();
  return typeof url === "string" && url.toLowerCase().startsWith(own);
}

function linkOk(url) {
  return url == null || url === "" || (typeof url === "string" && /^https:\/\/[^\s]+$/i.test(url) && url.length < 500);
}

// returns { changes, problems, held }. problems = refused outright, held = needs a human look
function check(current, wanted) {
  const changes = {}, problems = [], held = [];
  const authorId = current.authorId;
  const oldPics = [current.iconUrl, ...(current.screenshots || [])].filter(Boolean);

  for (const key of editable) {
    if (!(key in wanted)) continue;
    let value = wanted[key];
    if (JSON.stringify(value ?? null) === JSON.stringify(current[key] ?? null)) continue;

    if (["name", "summary", "description", "category", "license", "minGameVersion", "maxGameVersion"].includes(key)) {
      if (value != null && typeof value !== "string") { problems.push(`${key} isn't text`); continue; }
      value = value == null ? value : value.trim();
      if (limits[key] && value && value.length > limits[key]) { problems.push(`${key} is too long (max ${limits[key]})`); continue; }
      if (key === "name" && !value) { problems.push("the name can't be empty"); continue; }
      if (value && explicit.test(value)) held.push(`${key} tripped the word filter`);
    } else if (key === "tags" || key === "gameVersions") {
      if (!Array.isArray(value) || value.some(t => typeof t !== "string" || t.length > limits.tag)) { problems.push(`${key} isn't a list of short words`); continue; }
      if (value.length > limits.tags) { problems.push(`too many ${key}`); continue; }
      if (value.some(t => explicit.test(t))) held.push(`${key} tripped the word filter`);
    } else if (key === "screenshots") {
      if (!Array.isArray(value) || value.length > limits.screenshots) { problems.push("screenshot list is wrong or too long"); continue; }
      if (value.some(u => !pictureOk(u, authorId, oldPics))) { problems.push("a screenshot isn't from your BSMK-mods-uploads repo"); continue; }
    } else if (key === "iconUrl") {
      if (value != null && !pictureOk(value, authorId, oldPics)) { problems.push("the icon isn't from your BSMK-mods-uploads repo"); continue; }
    } else if (key === "deprecated" || key === "featured") {
      if (typeof value !== "boolean") { problems.push(`${key} must be yes/no`); continue; }
    } else {
      if (!linkOk(value)) { problems.push(`${key} must be a plain https link`); continue; }
      if (value === "") value = null;
    }
    changes[key] = value;
  }
  return { changes, problems, held };
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

async function discord(title, lines, pictures = []) {
  const content = `**${title}**\n${lines.join("\n")}\n${issue.html_url}`.slice(0, 1990);
  // Discord shows up to 4 pictures in one post when the embeds share a url
  const embeds = pictures.slice(0, 4).map(u => ({ url: issue.html_url, image: { url: u } }));
  if (dry) { console.log(`[discord] ${content}\n${pictures.join("\n")}`); return; }
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, embeds, allowed_mentions: { parse: [] } }),
  });
}

function describe(current, changes) {
  return Object.keys(changes).map(k => {
    const v = changes[k];
    if (["description"].includes(k)) return `• description changed (${(v || "").length} letters)`;
    if (k === "screenshots") return `• screenshots: ${v.length} (was ${(current.screenshots || []).length})`;
    if (k === "iconUrl") return "• new icon";
    const show = x => Array.isArray(x) ? x.join(", ") : String(x ?? "(none)");
    return `• ${k}: ${show(current[k]).slice(0, 80)} → ${show(v).slice(0, 200)}`;
  });
}

async function main() {
  const wanted = readRequest(issue.body || "");
  if (!wanted || !wanted.id) {
    await say("Couldn't read this listing edit. Please send it again from the BSMK Launcher.", true, ["rejected"]);
    return;
  }
  if (!dry && await isBanned(repo, token, opener, openerNum)) {
    await say("This account can't edit listings on the BSMK store.", true, ["rejected"]);
    return;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const { sha, catalog } = await readIndex();
    const current = catalog.mods.find(m => m.id.toLowerCase() === String(wanted.id).toLowerCase());
    if (!current) {
      await say(`There's no mod \`${wanted.id}\` on the store yet. New mods are sent for review from the launcher's Upload page.`, true, ["rejected"]);
      return;
    }
    followRename(catalog, opener, openerNum);
    if (!owns(current, opener, openerNum)) {
      await say(`Only the mod's own author (${current.authorId}) can edit this listing.`, true, ["rejected"]);
      await discord(`Listing edit REFUSED — ${current.name}`, [`${opener} tried to edit a listing owned by ${current.authorId}.`]);
      return;
    }

    const { changes, problems, held } = check(current, wanted);
    if (problems.length) {
      await say("Nothing was changed, because:\n" + problems.map(p => "- " + p).join("\n") + "\n\nFix it in the launcher and save again.", true, ["rejected"]);
      await discord(`Listing edit refused — ${current.name}`, [`by ${opener}`, ...problems.map(p => "• " + p)]);
      return;
    }
    if (!Object.keys(changes).length) {
      await say("Nothing to change, your listing already looks like that.", true, ["no-change"]);
      return;
    }
    const newPics = [changes.iconUrl, ...(changes.screenshots || [])].filter(u => u && !(current.screenshots || []).includes(u) && u !== current.iconUrl);
    if (held.length && !ownerApproved) {
      await say("Thanks! This edit is waiting for a quick look from the store team before it goes live.", false, ["held"]);
      await discord(`Listing edit HELD — ${current.name}`, [`by ${opener}`, ...held.map(h => "⚠ " + h), ...describe(current, changes),
        "Add the **approved** label to the issue to let it through, or close it to drop it."], newPics);
      return;
    }

    const summary = describe(current, changes);
    Object.assign(current, changes);
    current.authorNum ||= openerNum;
    current.updatedUtc = new Date().toISOString();
    catalog.updatedUtc = current.updatedUtc;
    if (dry) {
      console.log("[index] would write:", JSON.stringify(current, null, 2));
    } else {
      const put = await gh(`/repos/${repo}/contents/index.json`, "PUT", {
        message: `store: listing edit ${current.id} by ${opener}`,
        content: Buffer.from(JSON.stringify(catalog, null, 2)).toString("base64"),
        sha,
      });
      // 409 = the launcher or another edit wrote index.json since we read it. read again and redo.
      if (put.status === 409) continue;
      if (!put.ok) throw new Error("couldn't write index.json: " + put.status + " " + await put.text());
    }
    await say("Done, your listing is updated. It can take a few minutes to show in everyone's launcher.", true, ["applied"]);
    await discord(`Listing edit live — ${current.name}`, [`by ${opener}${ownerApproved ? " (approved by hand)" : ""}`, ...summary], newPics);
    return;
  }
  throw new Error("index.json kept changing under us, gave up after 5 tries");
}

main().catch(async e => {
  console.error(e);
  try { await discord("Listing edit FAILED", [String(e.message || e)]); } catch {}
  process.exit(1);
});
