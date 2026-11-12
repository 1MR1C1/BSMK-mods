// Runs once a day inside GitHub Actions on the store repo (see author-renames.yml).
// Dry run on a PC: GITHUB_TOKEN=... node author-renames.mjs --dry   (reads the live store, writes nothing)
const dry = process.argv[2] === "--dry";
const repo = process.env.GITHUB_REPOSITORY || "1MR1C1/BSMK-mods";
const token = process.env.GITHUB_TOKEN || "";
const webhook = process.env.DISCORD_WEBHOOK || "";
const api = "https://api.github.com";

function gh(path, method = "GET", body) {
  return fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-author-renames" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readFile(file) {
  const r = await gh(`/repos/${repo}/contents/${file}`);
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) };
}

async function writeFile(file, sha, data, message) {
  if (dry) { console.log(`[write] ${file}: ${message}`); return true; }
  const put = await gh(`/repos/${repo}/contents/${file}`, "PUT", {
    message, sha, content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
  });
  if (put.status === 409) return false;
  if (!put.ok) throw new Error(`couldn't write ${file}: ${put.status} ${await put.text()}`);
  return true;
}

async function discord(title, lines) {
  if (dry) { console.log(`[discord] ${title}\n${lines.join("\n")}`); return; }
  if (!webhook || !lines.length) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: `**${title}**\n${lines.join("\n")}`.slice(0, 1990), allowed_mentions: { parse: [] } }),
  });
}

// the account number is GitHub's own and outlives any rename. 404 = account deleted, or an old
// username nobody owns any more, so leave that mod alone rather than guess
async function userByNum(num) {
  const r = await gh(`/user/${num}`);
  return r.ok ? (await r.json()).login : null;
}
async function numByLogin(login) {
  const r = await gh(`/users/${encodeURIComponent(login)}`);
  return r.ok ? (await r.json()).id : null;
}

async function main() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const index = await readFile("index.json");
    if (!index) throw new Error("couldn't read index.json");
    const catalog = index.data;
    const notes = [], renames = new Map();   // old username (lower case) -> new username

    for (const m of catalog.mods) {
      if (m.authorNum || !m.authorId) continue;
      const num = await numByLogin(m.authorId);
      if (num) m.authorNum = num, notes.push(`${m.id}: now knows ${m.authorId}'s account number`);
    }
    const nums = [...new Set(catalog.mods.filter(m => m.authorNum).map(m => Number(m.authorNum)))];
    for (const num of nums) {
      const login = await userByNum(num);
      if (!login) continue;
      for (const m of catalog.mods.filter(x => Number(x.authorNum) === num && x.authorId !== login)) {
        renames.set(String(m.authorId).toLowerCase(), login);
        m.authorId = login;
      }
    }
    for (const [from, to] of renames) notes.push(`${from} renamed their GitHub to ${to}, their mods moved with them`);
    if (!notes.length) { console.log("nothing to do"); return; }

    if (!await writeFile("index.json", index.sha, catalog, "store: follow GitHub renames")) continue;

    // the trusted and banned lists name people by username too. a ban must survive a rename
    for (const file of ["trusted.json", "blocklist.json"]) {
      if (!renames.size) break;
      for (let tries = 0; tries < 3; tries++) {
        const list = await readFile(file);
        if (!list || !Array.isArray(list.data.Users)) break;
        let changed = false;
        list.data.Users = list.data.Users.map(u => {
          const to = renames.get(String(u).toLowerCase());
          if (to) changed = true;
          return to || u;
        });
        if (!changed || await writeFile(file, list.sha, list.data, "store: follow GitHub renames")) break;
      }
    }
    await discord("GitHub renames followed", notes.filter(n => n.includes("renamed")));
    console.log(notes.join("\n"));
    return;
  }
  throw new Error("index.json kept changing under us, gave up after 5 tries");
}

main().catch(e => { console.error(e); process.exit(1); });
