import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { installLocalStorage, MemoryStorage } from "../../../storageTestUtils";
import { prefsStore, resetPrefsStoreForTests } from "../../../stores/prefs";
import { Toast } from "../../../widgets";
import { resetToastStoreForTests } from "../../../widgets/toast/store";
import { toastKinds } from "../../../widgets/toast/toastTestUtils";
import { DisplaySection } from "./display";

beforeAll(() => {
  installLocalStorage(new MemoryStorage());
});

beforeEach(() => {
  localStorage.clear();
  resetPrefsStoreForTests();
  resetToastStoreForTests();
});

function renderWithToasts() {
  render(
    <>
      <DisplaySection />
      <Toast />
    </>,
  );
}

test("Enter sends remains the only Display setting and defaults off", () => {
  renderWithToasts();
  expect(screen.getByRole("switch", { name: "Enter sends" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getAllByRole("switch")).toHaveLength(1);
});

test("toggling Enter sends persists to the pinned key and toasts Settings saved", async () => {
  const user = userEvent.setup();
  renderWithToasts();

  await user.click(screen.getByRole("switch", { name: "Enter sends" }));

  expect(prefsStore.getState().enterToSend).toBe(true);
  expect(localStorage.getItem("evener.prefs.enterToSend")).toBe("1");
  await waitFor(() => expect(toastKinds()).toEqual(["success"]));
});

test("renders a Project session order row with the two options, Creation time checked by default", () => {
  renderWithToasts();

  expect(screen.getByRole("radiogroup", { name: "Project session order" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "Creation time" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("radio", { name: "Last activity" }).getAttribute("aria-checked")).toBe("false");
});

test("choosing Last activity persists setProjectSessionOrder('lastActivity') and toasts Settings saved", async () => {
  const user = userEvent.setup();
  renderWithToasts();

  await user.click(screen.getByRole("radio", { name: "Last activity" }));

  expect(prefsStore.getState().projectSessionOrder).toBe("lastActivity");
  expect(localStorage.getItem("evener.prefs.projectSessionOrder")).toBe("lastActivity");
  await waitFor(() => expect(toastKinds()).toEqual(["success"]));
});
