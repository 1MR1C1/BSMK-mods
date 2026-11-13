// Runs inside GitHub Actions on the store repo (see review-check.yml), on every new or edited comment on
// a "[reviews] <mod id>" issue. The launcher already refuses links and rude words before posting, so
// what lands here is mostly people posting straight on GitHub to get round it.
//   sure bad (scam/virus links, slurs)  -> hidden for everyone, marked "bad", the admin app copies it to
//                                          the evidence locker
//   flagged (any link, rude words,      -> hidden for everyone until the owner looks ("waiting")
//            account under a week old)
// hidden-comments.json on the store only keeps ids and the rule hit, never the text: the repo is public.
// Dry run on a PC: node review-check.mjs --dry <event.json> [hidden-comments.json] [account age in days]
import { readFileSync } from "node:fs";
import { isBanned } from "./authors.mjs";

const dry = process.argv[2] === "--dry";
const repo = process.env.GITHUB_REPOSITORY || "1MR1C1/BSMK-mods";
const token = process.env.GITHUB_TOKEN || "";
const owner = repo.split("/")[0];
const api = "https://api.github.com";
const FILE = "hidden-comments.json";

const event = JSON.parse(readFileSync(dry ? process.argv[3] : process.env.GITHUB_EVENT_PATH, "utf8"));
const { issue, comment } = event;

// same lists as the launcher's CommentFilter.cs, keep them in step
const link = /(https?:\/\/|www\.|\b\S+\.(com|net|org|io|gg|xyz|ru|link|to)\b)/i;
const explicit = /\b(porn|pornhub|xxx|nsfw|sex|sexual|nude|nudes|naked|boobs|tits|titty|nipple|penis|vagina|pussy|dick|cock|cum|blowjob|handjob|masturbat\w*|orgasm|hentai|rape|rapist|pedo|paedo|pedophile|paedophile|cp|loli|shota|fuck\w*|f4f|slut|whore|cunt|anal|creampie|deepthroat|bukkake|fetish|bdsm|onlyfans)\b/i;

// hate words with no innocent use in a game review. kept short on purpose, anything borderline is
// left to the owner instead of being called "sure"
const slurs = /\b(n[i1!]gg(?:er|a|as|ers|uh)|f[a@]gg?ots?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|wetbacks?|tr[a@]nn(?:y|ies)|retards?)\b/i;

// links that are only ever bad news here: ip grabbers, fake nitro/steam pages, files that run on
// download, and bare ip addresses
const scamLinks = [
  /\b(grabify|iplogger|2no\.co|blasze|ps3cfw|yip\.su|iplis\.ru|02ip\.ru|ezstat\.ru)\b/i,
  /\b(d[il1]sc[o0]rd(?!\.com\b|\.gg\b|app\.com\b)[\w-]*\.\w+|discord-?nitro|free-?nitro|nitro-?(gift|free))/i,
  /\bst[e3]a?m[\w-]*\.(?!steampowered\.com\b|steamcommunity\.com\b|steamstatic\.com\b)[a-z]{2,}\b/i,
  /https?:\/\/\S+\.(exe|scr|bat|cmd|msi|vbs|ps1|jar|apk)(\?|#|\s|$)/i,
  /https?:\/\/\d{1,3}(\.\d{1,3}){3}\b/,
];

function judge(text, ageDays) {
  if (slurs.test(text)) return { sure: true, rule: "hate word" };
  if (scamLinks.some(re => re.test(text))) return { sure: true, rule: "scam or virus link" };
  if (link.test(text)) return { sure: false, rule: "has a link" };
  if (explicit.test(text)) return { sure: false, rule: "rude or adult words" };
  if (ageDays !== null && ageDays < 7) return { sure: false, rule: `GitHub account only ${Math.max(0, Math.floor(ageDays))} days old` };
  return null;
}

function gh(path, method = "GET", body) {
  return fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-review-check" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function accountAgeDays(login) {
  if (dry) return process.argv[5] !== undefined ? +process.argv[5] : null;
  try {
    const r = await gh(`/users/${encodeURIComponent(login)}`);
    if (!r.ok) return null;
    return (Date.now() - new Date((await r.json()).created_at).getTime()) / 86400000;
  } catch { return null; }
}

// read-change-write like the other store lists; the workflow runs one at a time, the retry is for the
// admin app writing the same file in between
async function editHidden(change) {
  if (dry) {
    const data = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], "utf8")) : { Comments: [] };
    data.Comments ||= [];
    if (change(data.Comments) !== false) console.log(`[${FILE}]`, JSON.stringify(data, null, 2));
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let sha, data = { Comments: [] };
    const r = await gh(`/repos/${repo}/contents/${FILE}`);
    if (r.ok) { const j = await r.json(); sha = j.sha; data = JSON.parse(Buffer.from(j.content, "base64").toString("utf8")); }
    else if (r.status !== 404) throw new Error(`couldn't read ${FILE}: ${r.status}`);
    data.Comments ||= [];
    if (change(data.Comments) === false) return;
    const w = await gh(`/repos/${repo}/contents/${FILE}`, "PUT", {
      message: `hide review ${comment.id} (robot)`, sha,
      content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
    });
    if (w.ok) return;
    if (w.status !== 409) throw new Error(`couldn't save ${FILE}: ${w.status}`);
  }
  throw new Error(`${FILE} kept changing while saving`);
}

// folds it away on GitHub's own page too, so the web view doesn't show what the launcher hides
async function minimize(sure) {
  if (dry) { console.log(`[minimize] ${comment.node_id} as ${sure ? "ABUSE" : "SPAM"}`); return; }
  const query = `mutation($id:ID!,$c:ReportedContentClassifiers!){minimizeComment(input:{subjectId:$id,classifier:$c}){clientMutationId}}`;
  const r = await fetch(api + "/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "bsmk-review-check" },
    body: JSON.stringify({ query, variables: { id: comment.node_id, c: sure ? "ABUSE" : "SPAM" } }),
  });
  // hiding in the launcher is what matters, a failed fold on GitHub's page isn't worth failing the run
  if (!r.ok) console.log("minimize failed:", r.status, await r.text());
}

async function main() {
  if (!issue.title.startsWith("[reviews] ") || !comment) return;
  const login = comment.user.login;
  if (login.toLowerCase() === owner.toLowerCase() || comment.user.type === "Bot") return;

  const verdict = !dry && await isBanned(repo, token, login, comment.user.id)
    ? { sure: true, rule: "banned account" } : judge(comment.body || "", await accountAgeDays(login));
  if (!verdict) { console.log("fine:", comment.id); return; }

  await editHidden(list => {
    // an edit of something already on the list keeps the owner's decision, unless it got worse
    const was = list.find(e => e.id === comment.id);
    if (was && (was.sure || !verdict.sure)) return false;
    if (was) list.splice(list.indexOf(was), 1);
    list.push({
      id: comment.id, node: comment.node_id, issue: issue.number,
      mod: issue.title.slice("[reviews] ".length).trim(), author: login, authorId: comment.user.id,
      rule: verdict.rule, sure: verdict.sure, state: verdict.sure ? "bad" : "waiting",
      by: "robot", when: new Date().toISOString(), url: comment.html_url,
    });
  });
  await minimize(verdict.sure);
  // the star score on the store card mustn't count it. a run started with the robot's own token is the
  // one kind GitHub allows (it doesn't start workflows from the robot's normal writes)
  if (dry) console.log("[recount] review-stats.yml");
  else await gh(`/repos/${repo}/actions/workflows/review-stats.yml/dispatches`, "POST", { ref: "main" });
  console.log(`hidden ${comment.id}: ${verdict.rule}${verdict.sure ? " (sure)" : ""}`);
}

main().catch(e => { console.error(e); process.exit(1); });
