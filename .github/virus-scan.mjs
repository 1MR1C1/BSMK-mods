// Virus scan for mod files: ClamAV (installed by the workflow) plus VirusTotal (70-odd antivirus programs,
// free key in the VT_API_KEY secret). Used two ways:
//   - imported by mod-update.mjs, so an update that trips either one is held
//   - run on its own by virus-scan.yml, which BSMK Admin starts for brand-new mods in its inbox
// Results land as scans/<SHA256>.json on the store's "virus-scans" branch, away from index.json and
// everything the launcher reads. They're public like the mods themselves, nothing private goes in.
// Either scanner missing (no ClamAV on a PC, no key) just means "didn't run", never a pass or a fail.
// Run by hand: node virus-scan.mjs <url> <sha256>   (GITHUB_TOKEN, VT_API_KEY optional)
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = process.env.GITHUB_REPOSITORY || "1MR1C1/BSMK-mods";
const token = process.env.GITHUB_TOKEN || "";
const vtKey = process.env.VT_API_KEY || "";
const BRANCH = "virus-scans";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function gh(path, method = "GET", body) {
  return fetch("https://api.github.com" + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "bsmk-virus-scan" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function clam(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  const file = join(dir, "mod.dll");
  writeFileSync(file, bytes);
  const r = spawnSync("clamscan", ["--no-summary", "--infected", file], { encoding: "utf8", timeout: 5 * 60 * 1000 });
  if (r.error) return { ran: false, why: "ClamAV isn't installed here" };
  // 0 = clean, 1 = found something, 2 = couldn't scan (usually the virus list failed to download)
  if (r.status === 0) return { ran: true, found: [] };
  if (r.status === 1) return { ran: true, found: [...r.stdout.matchAll(/: (.+) FOUND/g)].map(m => m[1]) };
  return { ran: false, why: "ClamAV couldn't scan: " + (r.stderr || r.stdout).trim().split("\n").pop() };
}

function vtResult(attrs) {
  const stats = attrs.last_analysis_stats || attrs.stats || {};
  const results = attrs.last_analysis_results || attrs.results || {};
  const flagged = Object.entries(results).filter(([, v]) => v.category === "malicious" || v.category === "suspicious")
    .map(([engine, v]) => `${engine}: ${v.result || v.category}`);
  return {
    ran: true, malicious: stats.malicious || 0, suspicious: stats.suspicious || 0,
    // "undetected" + "harmless" is how many actually looked at it; timeouts and unsupported don't count
    total: (stats.malicious || 0) + (stats.suspicious || 0) + (stats.undetected || 0) + (stats.harmless || 0),
    flagged: flagged.slice(0, 20),
  };
}

async function virusTotal(bytes, sha) {
  if (!vtKey) return { ran: false, why: "no VirusTotal key set" };
  const vt = (path, init = {}) => fetch("https://www.virustotal.com/api/v3" + path, { ...init, headers: { "x-apikey": vtKey, ...(init.headers || {}) } });
  try {
    const known = await vt(`/files/${sha}`);
    if (known.ok) {
      const a = (await known.json()).data.attributes;
      if (a.last_analysis_results && Object.keys(a.last_analysis_results).length) return vtResult(a);
    } else if (known.status !== 404) {
      return { ran: false, why: `VirusTotal said no (${known.status})` };
    }
    // never seen before: send it, then wait. the free key allows 4 calls a minute, so ask every 20 seconds
    const form = new FormData();
    form.append("file", new Blob([bytes]), "mod.dll");
    const up = await vt("/files", { method: "POST", body: form });
    if (!up.ok) return { ran: false, why: `VirusTotal wouldn't take the file (${up.status})` };
    const analysis = (await up.json()).data.id;
    for (let i = 0; i < 24; i++) {
      await sleep(20000);
      const r = await vt(`/analyses/${analysis}`);
      if (!r.ok) continue;
      const a = (await r.json()).data.attributes;
      if (a.status === "completed") return vtResult(a);
    }
    return { ran: false, why: "VirusTotal took longer than 8 minutes, try again later" };
  } catch (e) {
    return { ran: false, why: "VirusTotal couldn't be reached: " + (e.message || e) };
  }
}

// one vote from one antivirus is often a false alarm on mod DLLs (they patch the game's code, which
// looks odd to some scanners), so that's "have a look"; ClamAV or two+ votes is "infected"
export function verdict(result) {
  const { clam, vt } = result;
  if (clam.ran && clam.found.length) return "infected";
  if (vt.ran && vt.malicious >= 2) return "infected";
  if (vt.ran && (vt.malicious || vt.suspicious)) return "suspicious";
  if (!clam.ran && !vt.ran) return "not scanned";
  return "clean";
}

export async function scanFile(bytes, sha = createHash("sha256").update(bytes).digest("hex")) {
  sha = sha.toUpperCase();
  const [clamR, vtR] = [clam(bytes), await virusTotal(bytes, sha)];
  const result = { sha256: sha, scannedUtc: new Date().toISOString(), clam: clamR, vt: vtR };
  result.verdict = verdict(result);
  return result;
}

// one line each, for issue comments, Discord and the app
export function describe(result) {
  const out = [];
  const { clam, vt } = result;
  if (!clam.ran) out.push(clam.why);
  else if (clam.found.length) out.push("ClamAV found " + clam.found.join(", "));
  else out.push("ClamAV: clean");
  if (!vt.ran) out.push(vt.why);
  else if (vt.malicious || vt.suspicious) out.push(`VirusTotal: ${vt.malicious + vt.suspicious} of ${vt.total} antivirus programs flagged it (${vt.flagged.slice(0, 4).join("; ")})`);
  else out.push(`VirusTotal: clean (0 of ${vt.total})`);
  return out;
}

// the results branch starts empty (no store files on it), so it's made from nothing the first time
async function ensureBranch() {
  if ((await gh(`/repos/${repo}/git/ref/heads/${BRANCH}`)).ok) return;
  const blob = await (await gh(`/repos/${repo}/git/blobs`, "POST", { content: "Virus scan results for store mods, one file per mod file (by its SHA256). Written by the store robot.\n", encoding: "utf-8" })).json();
  const tree = await (await gh(`/repos/${repo}/git/trees`, "POST", { tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob.sha }] })).json();
  const commit = await (await gh(`/repos/${repo}/git/commits`, "POST", { message: "virus scan results start here", tree: tree.sha, parents: [] })).json();
  const made = await gh(`/repos/${repo}/git/refs`, "POST", { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  // 422 = another scan made it a moment ago
  if (!made.ok && made.status !== 422) throw new Error("couldn't make the virus-scans branch: " + made.status);
}

export async function saveScan(result) {
  await ensureBranch();
  const path = `/repos/${repo}/contents/scans/${result.sha256}.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = await gh(`${path}?ref=${BRANCH}`);
    const body = {
      message: `virus scan ${result.sha256.slice(0, 12)}: ${result.verdict}`, branch: BRANCH,
      content: Buffer.from(JSON.stringify(result, null, 2)).toString("base64"),
      ...(old.ok ? { sha: (await old.json()).sha } : {}),
    };
    const put = await gh(path, "PUT", body);
    // 409 = two scans saved at the same moment, the branch moved under us
    if (put.status === 409) { await sleep(2000); continue; }
    if (!put.ok) throw new Error("couldn't save the scan: " + put.status + " " + await put.text());
    return;
  }
  throw new Error("couldn't save the scan, the branch kept moving");
}

async function main() {
  const url = process.argv[2] || process.env.SCAN_URL || "";
  const want = String(process.argv[3] || process.env.SCAN_SHA || "").toUpperCase();
  // only mod files on GitHub, so this can't be pointed at anything else
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//i.test(url)) throw new Error("not a GitHub release file: " + url);
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`couldn't download the file (${dl.status})`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (want && sha !== want) throw new Error("the file doesn't match the SHA256 asked for");
  const result = { ...(await scanFile(bytes, sha)), url };
  console.log(JSON.stringify(result, null, 2));
  if (token) await saveScan(result);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(e => { console.error(e); process.exit(1); });
