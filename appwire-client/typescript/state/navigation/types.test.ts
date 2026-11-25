import { expect, test } from "vitest";
import type { NavigationReadParams } from "../../types.gen";
import { keyID, NAVIGATION_CATALOG_LIMIT, NAVIGATION_SECTION_LIMIT, navigationParamsToResourceKey } from "./types";

// The hub serves an omitted `limit` as the MAXIMUM for the resource's family,
// not one shared default: navigationReadPage in cmd/evener-hub/app_navigation.go
// starts from the maximum it is given and only narrows it when the caller
// names one, and its callers pass maxNavigationSectionRows (50) for section,
// pin_section, project_page and subagents and maxNavigationCatalogRows (100)
// for catalog and pin_catalog (cmd/evener-hub/navigation_projection.go). A
// client that defaults a catalog to 50 names a page the hub never served.
test("an omitted limit is the hub's maximum for that resource family", () => {
  expect(NAVIGATION_SECTION_LIMIT).toBe(50);
  expect(NAVIGATION_CATALOG_LIMIT).toBe(100);

  const limitOf = (params: NavigationReadParams) => {
    const key = navigationParamsToResourceKey(params);
    return "limit" in key ? key.limit : undefined;
  };
  expect(limitOf({ representationVersion: 3, resource: "section", section: "live" })).toBe(50);
  expect(limitOf({ representationVersion: 3, resource: "pin_section", sectionId: "pins" })).toBe(50);
  expect(limitOf({ representationVersion: 3, resource: "project_page", projectKey: "p", tier: "current" })).toBe(50);
  expect(limitOf({ representationVersion: 3, resource: "catalog", catalog: "projects" })).toBe(100);
  expect(limitOf({ representationVersion: 3, resource: "pin_catalog" })).toBe(100);
});

test("an explicit page wins over the maximum, and an unpaged resource carries none", () => {
  expect(
    navigationParamsToResourceKey({
      representationVersion: 3,
      resource: "catalog",
      catalog: "projects",
      offset: 100,
      limit: 25,
    }),
  ).toEqual({ kind: "catalog", catalog: "projects", offset: 100, limit: 25 });
  expect(navigationParamsToResourceKey({ representationVersion: 3, resource: "manifest" })).toEqual({
    kind: "manifest",
  });
  expect(navigationParamsToResourceKey({ representationVersion: 3, resource: "project", projectKey: "p" })).toEqual({
    kind: "project",
    projectKey: "p",
  });
  expect(navigationParamsToResourceKey({ representationVersion: 3, resource: "location", ref: "local:a" })).toEqual({
    kind: "location",
    ref: "local:a",
  });
});

// A project_page read's sort key names a different resource from the same
// page in the default order: the hub keys its cache, etag and view scope by
// it (navigationReadKeyWithFields in cmd/evener-hub/app_navigation.go,
// navigationViewScope in cmd/evener-hub/navigation_cache.go), so the client
// key must carry it or both orders share one cached entry. An absent sort key
// - or an empty string, the wire's default - is the createdAt order the hub
// has always served, and keeps the key that read always had.
test("project_page params carry the sort key only when one is named", () => {
  expect(
    navigationParamsToResourceKey({
      representationVersion: 3,
      resource: "project_page",
      projectKey: "p",
      tier: "current",
      sortKey: "lastActivity",
    }),
  ).toEqual({
    kind: "project_page",
    projectKey: "p",
    tier: "current",
    offset: 0,
    limit: 50,
    sortKey: "lastActivity",
  });
  const defaultPage = { kind: "project_page", projectKey: "p", tier: "current", offset: 0, limit: 50 };
  expect(
    navigationParamsToResourceKey({
      representationVersion: 3,
      resource: "project_page",
      projectKey: "p",
      tier: "current",
    }),
  ).toEqual(defaultPage);
  expect(
    navigationParamsToResourceKey({
      representationVersion: 3,
      resource: "project_page",
      projectKey: "p",
      tier: "current",
      sortKey: "",
    }),
  ).toEqual(defaultPage);
});

test("keyID distinguishes project pages that differ only by sort key", () => {
  const page = { kind: "project_page", projectKey: "p", tier: "current", offset: 0, limit: 50 } as const;
  expect(keyID(page)).not.toBe(keyID({ ...page, sortKey: "lastActivity" }));
  expect(keyID({ ...page, sortKey: "createdAt" })).not.toBe(keyID({ ...page, sortKey: "lastActivity" }));
});
