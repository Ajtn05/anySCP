import { Check } from "lucide-react";
import { useSettingsStore, type InterfaceStyle } from "../../stores/settings-store";

const STYLES: { value: InterfaceStyle; label: string; description: string }[] = [
  { value: "classic", label: "Classic", description: "Original cards and floating navigation." },
  { value: "studio", label: "Studio", description: "Quiet surfaces, generous space, clear hierarchy." },
  { value: "workbench", label: "Workbench", description: "Compact rows with addresses and actions in view." },
];

export function InterfaceStylePicker() {
  const current = useSettingsStore((s) => s.interfaceStyle);
  const setStyle = useSettingsStore((s) => s.setInterfaceStyle);

  return (
    <fieldset className="interface-style-picker">
      <legend>Interface style</legend>
      <p className="style-picker-description">Choose how your workspace is arranged.</p>
      <div className="style-options">
        {STYLES.map(({ value, label, description }) => (
          <label key={value} className="style-option">
            <input type="radio" name="interface-style" value={value} checked={current === value}
              onChange={() => setStyle(value)} data-testid={`interface-style-${value}`} />
            <span className={`style-preview style-preview-${value}`} aria-hidden="true">
              <span className="style-preview-rail"><i /><i /><i /></span>
              <span className="style-preview-workspace">
                <span className="style-preview-tabs"><i /><i /></span>
                <span className="style-preview-content"><i /><span><b /><b /><b /></span></span>
              </span>
            </span>
            <span className="style-option-heading">{label}<Check size={14} aria-hidden="true" /></span>
            <span className="style-option-description">{description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
