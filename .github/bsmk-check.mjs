// Does a mod DLL carry the BSMK check (mods-workshop/Shared/BSMKCheck.cs)? From the date in
// bsmk-check.json (store repo root) the store won't take new mods or updates without it, so a BSMK mod
// can't be run on a look-alike Core. Before that date it's only a reminder. tools/Approve reads the same file.
//
// It looks for the words the check leaves in every DLL that compiles it in: the class and method names
// (plain zero-ended text), and the start of our public key, which .NET stores as UTF-16 text.
// It proves the file is in the mod, not that Awake calls it. New mods get that looked at by hand.

const keyStart = "uHs9UP3a3cM3nKcQO9/qHRUWa/h6DWoUQZh9oNH8hz7s";

export function hasCheck(bytes) {
  const words = new Set(bytes.toString("latin1").split("\0"));
  return words.has("BSMKCheck") && words.has("Passed") && bytes.includes(Buffer.from(keyStart, "utf16le"));
}

// { requiredFrom: "YYYY-MM-DD" or null, signedCore: "1.0.16" }
export function required(settings, now = new Date()) {
  return !!settings?.requiredFrom && now >= new Date(settings.requiredFrom + "T00:00:00Z");
}

// a mod with the check refuses any Core older than the first signed one, so the launcher has to fetch
// that Core first or the player sees the "only runs with BSMK" box for no good reason
export function raiseMinCore(entry, settings, newer) {
  const signed = settings?.signedCore;
  if (signed && (!entry.minCoreVersion || newer(signed, entry.minCoreVersion))) entry.minCoreVersion = signed;
}

export const howTo = "add the BSMK check: drop BSMKCheck.cs into your project and put `if (!BSMKCheck.Passed(this)) return;` as the first line of your plugin's Awake. Steps and the file are in the SDK guide (TOOLBOX-SDK.md, \"The BSMK check\").";
