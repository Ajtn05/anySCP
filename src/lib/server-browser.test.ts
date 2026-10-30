import { describe, expect, it } from "vitest";
import { parseServerBrowsers, serverBrowserKey } from "./server-browser";

describe("server browser preferences", () => {
  it("uses stable saved IDs and distinguishes quick connections by user and port", () => {
    const host = { host: "example.com", username: "deploy", port: 22 };
    expect(serverBrowserKey({ ...host, id: "one" })).toBe("host:one");
    expect(serverBrowserKey({ ...host, id: "one" })).not.toBe(serverBrowserKey({ ...host, id: "two" }));
    expect(serverBrowserKey(host)).not.toBe(serverBrowserKey({ ...host, port: 2222 }));
    expect(serverBrowserKey(host)).not.toBe(serverBrowserKey({ ...host, username: "root" }));
  });

  it("ignores malformed records, normalizes pins, and removes duplicates", () => {
    expect(parseServerBrowsers("invalid json")).toEqual({});
    expect(parseServerBrowsers("null")).toEqual({});
    expect(parseServerBrowsers(JSON.stringify({
      "host:one": { layout: "drive", pinnedPaths: [{ path: "/srv/app/", label: " App " }, { path: "/srv/app/." }, null, { path: "relative" }, { path: "/", label: "" }] },
      "host:two": { layout: "unknown", pinnedPaths: "invalid" },
      "host:three": null, "__proto__": { layout: "drive" },
    }))).toEqual({
      "host:one": { layout: "drive", pinnedPaths: [{ path: "/srv/app", label: "App" }, { path: "/", label: "Filesystem root" }] },
      "host:two": { layout: "classic", pinnedPaths: [] },
    });
  });
});
