// useRpc bound to the host of the mounted screen, as in Paseo, where each host runs its own copy.
import { createContext, createElement, useCallback, useContext } from "react";

const Host = createContext(null);
export const HostRpc = ({ call, children }) => createElement(Host.Provider, { value: call }, children);
export function useRpc(contract) {
  const call = useContext(Host);
  return useCallback((input) => call(contract.name, input), [call, contract]);
}
export const opened = [];
export async function openExternalUrl(url) {
  opened.push(url);
}
const loading = { status: "loading", saving: false, saveError: null, save: async () => false, reset: async () => false, reload: async () => undefined };
export const useSettings = () => loading;
