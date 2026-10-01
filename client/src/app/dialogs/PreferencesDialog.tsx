import { useState } from 'react';
import { Monitor, Moon, Settings, Sun } from 'lucide-react';
import { actions, useApp, type Prefs } from '@/core/store';
import { Button, Modal, SegmentedControl, Select, Switch, TextField } from '@/core/ui';

function PreferencesBody({ close }: { close(): void }) {
  const initial = useApp.getState().prefs;
  const [draft, setDraft] = useState<Prefs>(initial);
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const nameError = draft.userName.trim() === '' ? 'Enter a name' : null;
  const save = () => {
    if (nameError) return;
    actions.setPrefs({ ...draft, userName: draft.userName.trim() });
    close();
  };
  return (
    <Modal
      title="Preferences"
      icon={Settings}
      width={540}
      onClose={close}
      className="prefs-dialog"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!!nameError} data-testid="prefs-save">
            Save
          </Button>
        </>
      }
    >
      <form
        className="prefs-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="prefs-section">
          <h3 className="prefs-section-title">General</h3>
          <TextField
            label="Name"
            value={draft.userName}
            onChange={(v) => set('userName', v)}
            help="Shown as the author of your comments and markups."
            error={nameError}
            maxLength={80}
            data-testid="prefs-name"
          />
          <div className="field">
            <span className="field-label">Theme</span>
            <SegmentedControl
              value={draft.theme}
              onChange={(v) => set('theme', v)}
              label="Theme"
              options={[
                { value: 'light', label: 'Light', icon: Sun },
                { value: 'dark', label: 'Dark', icon: Moon },
                { value: 'system', label: 'System', icon: Monitor },
              ]}
            />
          </div>
        </section>
        <section className="prefs-section">
          <h3 className="prefs-section-title">Documents</h3>
          <Select
            label="Default zoom"
            value={draft.defaultFit}
            onChange={(v) => set('defaultFit', v)}
            width={220}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'width', label: 'Fit width' },
              { value: 'page', label: 'Fit page' },
            ]}
          />
          <Switch
            label="Show the tools panel when opening a document"
            checked={draft.showToolsPanel}
            onChange={(v) => set('showToolsPanel', v)}
          />
          <Switch
            label="Show quick actions when selecting text"
            description="Highlight, copy and other actions appear next to selected text."
            checked={draft.selectionPopup}
            onChange={(v) => set('selectionPopup', v)}
          />
        </section>
      </form>
    </Modal>
  );
}

export function openPreferences() {
  return actions.openModal<void>((close) => <PreferencesBody close={() => close()} />);
}
