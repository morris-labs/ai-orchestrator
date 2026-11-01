// The profile menu and the role table, shared by the launcher and the run view.
import { ProfileSchema, RoleSchema, type Profile, type Role, type Vendor } from "@aio/contracts";
import { VENDOR_LABELS, VENDORS, vendorColor } from "@aio/ui/dashboard";
import type { ReactNode } from "react";
import { isMultiVendor, type RoleDraft } from "./rolesModel.js";

export const PROFILE_LABELS: Record<Profile, string> = {
  offload: "offload: Claude fixes only",
  balanced: "balanced: Claude reviews rounds 1 and 2",
  fast: "fast: Claude reviews every round",
};

export function ProfileSelect({
  value,
  disabled,
  onChange,
}: {
  value: Profile;
  disabled?: boolean;
  onChange: (profile: Profile) => void;
}) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Profile)}>
      {ProfileSchema.options.map((p) => (
        <option key={p} value={p}>
          {PROFILE_LABELS[p]}
        </option>
      ))}
    </select>
  );
}

/**
 * A table with a row per role and a column per vendor: checkboxes for
 * `reviewer`, which takes several vendors, and radio buttons for the other
 * roles. `action` adds a last column, such as the run view's Assign button.
 */
export function RoleTable({
  value,
  disabled,
  onChange,
  action,
  name = "role",
}: {
  value: RoleDraft;
  disabled?: boolean;
  onChange: (role: Role, vendors: Vendor[]) => void;
  action?: { header: string; render: (role: Role, chosen: Vendor[]) => ReactNode };
  /** Prefixes the radio group names, so two tables on a page don't share groups. */
  name?: string;
}) {
  return (
    <table className="ab-table" aria-label="Roles">
      <thead>
        <tr>
          <th scope="col">Role</th>
          {VENDORS.map((v) => (
            <th key={v} scope="col">
              <span className="ab-key-rect" style={{ background: vendorColor(v) }} />
              {VENDOR_LABELS[v]}
            </th>
          ))}
          {action ? (
            <th scope="col">
              <span className="visually-hidden">{action.header}</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {RoleSchema.options.map((role) => {
          const multi = isMultiVendor(role);
          const chosen = value[role];
          return (
            <tr key={role}>
              <th scope="row">{role}</th>
              {VENDORS.map((v) => (
                <td key={v}>
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={`${name}-${role}`}
                    aria-label={`${role}: ${VENDOR_LABELS[v]}`}
                    checked={chosen.includes(v)}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange(
                        role,
                        multi
                          ? VENDORS.filter((x) => (x === v ? e.target.checked : chosen.includes(x)))
                          : [v],
                      )
                    }
                  />
                </td>
              ))}
              {action ? <td>{action.render(role, chosen)}</td> : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
