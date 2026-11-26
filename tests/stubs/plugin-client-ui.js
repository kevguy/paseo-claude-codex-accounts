// Settings rows as plain elements, and a toast that records what it was asked to show.
export const SettingsAction = "SettingsAction", SettingsCard = "SettingsCard", SettingsInput = "SettingsInput";
export const SettingsSection = "SettingsSection", SettingsSelect = "SettingsSelect", SettingsSwitch = "SettingsSwitch";
export const toasts = [];
const toast = { show: (text) => toasts.push(text), error: (text) => toasts.push(`error: ${text}`) };
export const useToast = () => toast;
export async function copyText() {}
