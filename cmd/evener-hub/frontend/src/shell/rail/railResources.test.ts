import { describe, expect, test } from "vitest";
import type { RailSession } from "./railNodes";
import { compareProjectSessions } from "./railResources";

function row(overrides: Partial<RailSession>): RailSession {
  return {
    ref: "local:a",
    row_id: "navigation:local:a",
    host_id: "local",
    session_id: "a",
    title: "Session A",
    project: "Proj",
    state: "idle",
    kind: "session",
    live: true,
    children: [],
    ...overrides,
  };
}

describe("project session order", () => {
  test("joins the current and recent tiers newest-created first", () => {
    const current = row({
      ref: "local:current",
      row_id: "navigation:local:current",
      title: "Current",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-11-05T00:00:00Z",
    });
    const recent = row({
      ref: "local:recent",
      row_id: "navigation:local:recent",
      title: "Recent",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    });
    expect([current, recent].sort(compareProjectSessions)).toEqual([recent, current]);
  });

  test("a later update does not move a row past a newer-created one", () => {
    const olderCreated = row({
      ref: "local:older",
      row_id: "navigation:local:older",
      title: "Older",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-11-05T12:00:00Z",
    });
    const newerCreated = row({
      ref: "local:newer",
      row_id: "navigation:local:newer",
      title: "Newer",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });
    expect([olderCreated, newerCreated].sort(compareProjectSessions)).toEqual([newerCreated, olderCreated]);
  });

  test("falls back to updated_at for a hub without created_at", () => {
    const older = row({ row_id: "navigation:old", updated_at: "2026-01-01T00:00:00Z" });
    const newer = row({ row_id: "navigation:new", updated_at: "2026-06-01T00:00:00Z" });
    expect([older, newer].sort(compareProjectSessions)).toEqual([newer, older]);
  });

  test("places an untimestamped row after every timestamped row", () => {
    const timestamped = row({ row_id: "navigation:timestamped", created_at: "2026-01-01T00:00:00Z" });
    const untimestamped = row({ row_id: "navigation:untimestamped" });
    expect([untimestamped, timestamped].sort(compareProjectSessions)).toEqual([timestamped, untimestamped]);
  });

  test("an explicit createdAt mode keeps today's creation-first order", () => {
    const olderCreated = row({
      ref: "local:older",
      row_id: "navigation:local:older",
      title: "Older",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-11-05T12:00:00Z",
    });
    const newerCreated = row({
      ref: "local:newer",
      row_id: "navigation:local:newer",
      title: "Newer",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });
    expect([olderCreated, newerCreated].sort((a, b) => compareProjectSessions(a, b, "createdAt"))).toEqual([
      newerCreated,
      olderCreated,
    ]);
  });

  test("lastActivity mode orders the joined tiers newest-activity first", () => {
    const current = row({
      ref: "local:current",
      row_id: "navigation:local:current",
      title: "Current",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-11-05T00:00:00Z",
    });
    const recent = row({
      ref: "local:recent",
      row_id: "navigation:local:recent",
      title: "Recent",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    });
    expect([current, recent].sort((a, b) => compareProjectSessions(a, b, "lastActivity"))).toEqual([current, recent]);
  });

  test("lastActivity mode moves a later-updated row above a newer-created one", () => {
    const olderCreated = row({
      ref: "local:older",
      row_id: "navigation:local:older",
      title: "Older",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-11-05T12:00:00Z",
    });
    const newerCreated = row({
      ref: "local:newer",
      row_id: "navigation:local:newer",
      title: "Newer",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    });
    expect([olderCreated, newerCreated].sort((a, b) => compareProjectSessions(a, b, "lastActivity"))).toEqual([
      olderCreated,
      newerCreated,
    ]);
  });

  test("lastActivity mode falls back to created_at for a row without updated_at", () => {
    const older = row({ row_id: "navigation:old", created_at: "2026-01-01T00:00:00Z" });
    const newer = row({ row_id: "navigation:new", created_at: "2026-06-01T00:00:00Z" });
    expect([older, newer].sort((a, b) => compareProjectSessions(a, b, "lastActivity"))).toEqual([newer, older]);
  });

  test("lastActivity mode places an untimestamped row after every timestamped row", () => {
    const timestamped = row({
      row_id: "navigation:timestamped",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const untimestamped = row({ row_id: "navigation:untimestamped" });
    expect([untimestamped, timestamped].sort((a, b) => compareProjectSessions(a, b, "lastActivity"))).toEqual([
      timestamped,
      untimestamped,
    ]);
  });

  test("lastActivity mode breaks activity ties on title then row id", () => {
    // The two rows share an updated_at but disagree with creation order, so
    // only the activity mode's tiebreak - not the createdAt order - can put
    // them in the expected order.
    const updated = "2026-05-01T00:00:00Z";
    const byTitle = [
      row({ row_id: "navigation:z", title: "Beta", created_at: "2026-06-01T00:00:00Z", updated_at: updated }),
      row({ row_id: "navigation:a", title: "alpha", created_at: "2026-01-01T00:00:00Z", updated_at: updated }),
    ];
    expect(byTitle.slice().sort((a, b) => compareProjectSessions(a, b, "lastActivity"))).toEqual([
      byTitle[1],
      byTitle[0],
    ]);
    const byID = [
      row({ row_id: "navigation:b", title: "Same", created_at: "2026-06-01T00:00:00Z", updated_at: updated }),
      row({ row_id: "navigation:a", title: "Same", created_at: "2026-01-01T00:00:00Z", updated_at: updated }),
    ];
    expect(byID.slice().sort((a, b) => compareProjectSessions(a, b, "lastActivity"))).toEqual([byID[1], byID[0]]);
  });
});
