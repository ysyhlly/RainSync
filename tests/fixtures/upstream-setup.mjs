import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

/** Shared setup flow for isolated compatibility fixtures, never personal servers. */
export async function setupUpstreamFixture({
  base,
  credentialFile,
  expectedVersion,
  needsStartup,
  serverUrl,
  readLibraries,
}) {
  let credentials;
  try {
    credentials = JSON.parse(await readFile(credentialFile, "utf8"));
  } catch {
    credentials = {
      username: "rainsync-fixture",
      password: randomBytes(24).toString("hex"),
    };
    await writeFile(credentialFile, JSON.stringify(credentials));
  }
  let token = "";
  async function api(path, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `MediaBrowser Client="RainSync Verification", Device="Fixture", DeviceId="rainsync-fixture", Version="0.1.0"${token ? `, Token="${token}"` : ""}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const info = await api("/System/Info/Public");
  assert.equal(info.Version, expectedVersion);
  if (needsStartup(info, credentials)) {
    await api("/Startup/Configuration", "POST", {
      ServerName: "RainSync verification only",
      UICulture: "en-US",
      MetadataCountryCode: "US",
      PreferredMetadataLanguage: "en",
    });
    await api("/Startup/User", "POST", {
      Name: credentials.username,
      Password: credentials.password,
    });
    await api("/Startup/RemoteAccess", "POST", {
      EnableRemoteAccess: true,
      EnableAutomaticPortMapping: false,
    });
    await api("/Startup/Complete", "POST");
  }
  const auth = await api("/Users/AuthenticateByName", "POST", {
    Username: credentials.username,
    Pw: credentials.password,
  });
  token = auth.AccessToken;
  credentials = {
    ...credentials,
    token,
    user_id: auth.User.Id,
    url: serverUrl,
  };
  await writeFile(credentialFile, JSON.stringify(credentials));
  const libraries = await readLibraries(api);
  if (!libraries.some((v) => v.Name === "RainSync fixtures")) {
    await api(
      "/Library/VirtualFolders?name=RainSync%20fixtures&collectionType=homevideos&refreshLibrary=true",
      "POST",
      {
        LibraryOptions: {
          PathInfos: [{ Path: "/media" }],
          EnableRealtimeMonitor: false,
          EnableInternetProviders: false,
          SaveLocalMetadata: false,
        },
      },
    );
  }
  await api("/Library/Refresh", "POST");
  let items = [];
  for (let i = 0; i < 60; i++) {
    items = (
      await api(
        `/Users/${auth.User.Id}/Items?Recursive=true&IncludeItemTypes=Video,Movie&Fields=MediaSources`,
      )
    ).Items;
    if (items.length >= 2) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(items.length >= 2, "fixture library indexed");
  console.log(
    JSON.stringify({
      version: info.Version,
      items: items.map((i) => ({ id: i.Id, name: i.Name })),
    }),
  );
}
