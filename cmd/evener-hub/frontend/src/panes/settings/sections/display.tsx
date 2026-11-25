import { type ProjectSessionOrderPref, prefsStore, usePrefsStore } from "../../../stores/prefs";
import { RadioGroup, Switch, useToasts } from "../../../widgets";
import { requireClass } from "../../../widgets/internal/requireClass";
import styles from "./display.module.css";

const CLASS = {
  root: requireClass(styles.root, "display.module.css", "root"),
  intro: requireClass(styles.intro, "display.module.css", "intro"),
};

const PROJECT_SESSION_ORDER_OPTIONS = [
  { value: "createdAt", label: "Creation time" },
  { value: "lastActivity", label: "Last activity" },
];

/**
 * Browser-local display preferences, composed into Input & shortcuts and the
 * project page's session ordering. Saved per-browser.
 */
export function DisplaySection() {
  const enterToSend = usePrefsStore((s) => s.enterToSend);
  const projectSessionOrder = usePrefsStore((s) => s.projectSessionOrder);
  const { push } = useToasts();

  return (
    <div className={CLASS.root}>
      <p className={CLASS.intro}>Display preferences. Saved per-browser.</p>

      <Switch
        label="Enter sends"
        checked={enterToSend}
        onChange={(value) => {
          prefsStore.getState().setEnterToSend(value);
          push("success", "Settings saved");
        }}
        description="Default off: ⌘/Ctrl-Enter sends, Enter inserts a newline. On: Enter sends, Shift-Enter inserts a newline (the Shift-Enter shortcut for steering — sending the agent a mid-run correction — is unavailable in this mode; the steer button still works)."
      />

      <RadioGroup
        label="Project session order"
        value={projectSessionOrder}
        onChange={(value) => {
          prefsStore.getState().setProjectSessionOrder(value as ProjectSessionOrderPref);
          push("success", "Settings saved");
        }}
        options={PROJECT_SESSION_ORDER_OPTIONS}
        description="How a project page orders its sessions. Falls back to Creation time if the saved choice can't be read."
      />
    </div>
  );
}
