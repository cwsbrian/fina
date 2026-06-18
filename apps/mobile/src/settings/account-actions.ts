import type { ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

export type AccountSettingsActionKey =
  | "edit-profile"
  | "reset-password"
  | "export-data"
  | "delete-account"
  | "sign-out";

export type AccountSettingsAction = {
  key: AccountSettingsActionKey;
  icon: IoniconName;
  title: string;
  danger?: boolean;
};

export function getAccountSettingsActions(): AccountSettingsAction[] {
  return [
    {
      key: "edit-profile",
      icon: "person-outline",
      title: "Edit profile",
    },
    {
      key: "reset-password",
      icon: "lock-closed-outline",
      title: "Reset password",
    },
    {
      key: "export-data",
      icon: "download-outline",
      title: "Export data",
    },
    {
      key: "delete-account",
      icon: "trash-outline",
      title: "Delete account",
      danger: true,
    },
    {
      key: "sign-out",
      icon: "log-out-outline",
      title: "Sign out",
    },
  ];
}
